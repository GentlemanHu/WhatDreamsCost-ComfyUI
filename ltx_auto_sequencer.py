from comfy_extras.nodes_lt import LTXVAddGuide
import torch
from comfy_api.latest import io


class LTXAutoSequencer(LTXVAddGuide):
    """
    Auto-distributes batched images as LTX guide keyframes across the video timeline.
    Accepts images from ANY source - MultiImageLoader, generative nodes, etc.
    No manual per-image frame assignment needed.
    """

    @classmethod
    def define_schema(cls):
        inputs = [
            io.Conditioning.Input(
                "positive",
                tooltip="Positive conditioning to which guide keyframe info will be added",
            ),
            io.Conditioning.Input(
                "negative",
                tooltip="Negative conditioning to which guide keyframe info will be added",
            ),
            io.Vae.Input("vae", tooltip="Video VAE used to encode the guide images"),
            io.Latent.Input(
                "latent",
                tooltip="Video latent; total frame count is derived from this automatically",
            ),
            io.Image.Input(
                "images",
                tooltip=(
                    "Batched images from ANY source: MultiImageLoader, KSampler output, "
                    "image generators, etc. All images are auto-distributed across the timeline."
                ),
            ),
            io.Combo.Input(
                "distribution_mode",
                options=["even", "first_last", "first_last_even", "fixed_interval", "custom_pattern"],
                default="even",
                tooltip=(
                    "How to auto-distribute images across the video timeline:\n"
                    "  even            — equally spaced, including first and last frame\n"
                    "  first_last      — image[0] at frame 0, image[-1] at final frame, rest at frame 0\n"
                    "  first_last_even — image[0]=start, image[-1]=end, middle images evenly spaced\n"
                    "  fixed_interval  — every N frames/seconds starting from frame 0\n"
                    "  custom_pattern  — comma-separated positions, cycled if fewer than image count"
                ),
            ),
            io.Float.Input(
                "global_strength",
                default=1.0,
                min=0.0,
                max=1.0,
                step=0.01,
                tooltip="Strength applied uniformly to all auto-placed keyframes",
            ),
            io.Int.Input(
                "frame_rate",
                default=24,
                min=1,
                max=120,
                step=1,
                tooltip="Video FPS — used when interval_unit or pattern_unit is set to seconds",
            ),
            # --- fixed_interval mode ---
            io.Float.Input(
                "interval",
                default=24.0,
                min=0.1,
                max=9999.0,
                step=0.5,
                tooltip="Spacing between consecutive images (used in fixed_interval mode)",
                optional=True,
            ),
            io.Combo.Input(
                "interval_unit",
                options=["frames", "seconds"],
                default="frames",
                tooltip="Unit for the interval value: pixel frames or seconds",
                optional=True,
            ),
            # --- custom_pattern mode ---
            io.String.Input(
                "custom_pattern",
                default="0, 0.25, 0.5, 0.75, 1.0",
                multiline=False,
                placeholder="e.g.  0, 0.25, 0.5, 1.0   or   0, 24, 48, 96",
                tooltip=(
                    "Comma-separated positions used in custom_pattern mode.\n"
                    "Interpreted according to pattern_unit.\n"
                    "If there are fewer values than images, the list is cycled.\n"
                    "normalized_0_to_1 : 0.0 = first frame, 1.0 = last frame\n"
                    "absolute_frames   : pixel-space frame numbers\n"
                    "absolute_seconds  : time in seconds"
                ),
                optional=True,
            ),
            io.Combo.Input(
                "pattern_unit",
                options=["normalized_0_to_1", "absolute_frames", "absolute_seconds"],
                default="normalized_0_to_1",
                tooltip=(
                    "Unit for custom_pattern values:\n"
                    "  normalized_0_to_1 — 0 = start, 1 = end of video\n"
                    "  absolute_frames   — pixel-space frame numbers\n"
                    "  absolute_seconds  — time in seconds (uses frame_rate)"
                ),
                optional=True,
            ),
        ]

        return io.Schema(
            node_id="LTXAutoSequencer",
            display_name="LTX Auto Sequencer",
            category="LTXVCustom",
            description=(
                "Automatically distributes batched images as LTX guide keyframes across "
                "the video timeline. Accepts images from any source — MultiImageLoader, "
                "generative nodes, etc. No per-image frame assignment needed."
            ),
            inputs=inputs,
            outputs=[
                io.Conditioning.Output(display_name="positive"),
                io.Conditioning.Output(display_name="negative"),
                io.Latent.Output(
                    display_name="latent",
                    tooltip="Video latent with auto-distributed guide frames applied",
                ),
            ],
        )

    # ------------------------------------------------------------------
    # Position computation helpers
    # ------------------------------------------------------------------

    @classmethod
    def _compute_positions(cls, num_images, pixel_frame_count, distribution_mode, frame_rate, **kwargs):
        """
        Compute pixel-space frame indices for each image in the batch.

        Args:
            num_images        : number of images in the batch
            pixel_frame_count : total frames in pixel space (int)
            distribution_mode : one of the five mode strings
            frame_rate        : FPS (int), used for seconds conversions
            **kwargs          : interval, interval_unit, custom_pattern, pattern_unit

        Returns:
            list[int] of length num_images, each clamped to [0, pixel_frame_count-1].
        """
        if num_images == 0:
            return []

        total = pixel_frame_count  # alias for readability

        # ------ even ------
        if distribution_mode == "even":
            if num_images == 1:
                return [0]
            step = (total - 1) / (num_images - 1)
            return [round(i * step) for i in range(num_images)]

        # ------ first_last ------
        elif distribution_mode == "first_last":
            if num_images == 1:
                return [0]
            # First maps to 0, last maps to end, everything in between also gets 0
            positions = [0] * num_images
            positions[-1] = total - 1
            return positions

        # ------ first_last_even ------
        elif distribution_mode == "first_last_even":
            if num_images == 1:
                return [0]
            if num_images == 2:
                return [0, total - 1]
            # Same as 'even' — first=0, last=end, middle evenly spaced
            step = (total - 1) / (num_images - 1)
            return [round(i * step) for i in range(num_images)]

        # ------ fixed_interval ------
        elif distribution_mode == "fixed_interval":
            interval = float(kwargs.get("interval", 24.0))
            interval_unit = kwargs.get("interval_unit", "frames")
            if interval_unit == "seconds":
                interval_frames = interval * frame_rate
            else:
                interval_frames = interval
            interval_frames = max(1.0, interval_frames)

            positions = []
            for i in range(num_images):
                pos = round(i * interval_frames)
                pos = min(pos, total - 1)
                positions.append(pos)
            return positions

        # ------ custom_pattern ------
        elif distribution_mode == "custom_pattern":
            pattern_str = kwargs.get("custom_pattern", "0, 0.25, 0.5, 0.75, 1.0") or ""
            pattern_unit = kwargs.get("pattern_unit", "normalized_0_to_1")

            try:
                raw_vals = [float(v.strip()) for v in pattern_str.split(",") if v.strip()]
            except ValueError:
                print(
                    f"LTXAutoSequencer: Invalid custom_pattern '{pattern_str}', "
                    "falling back to even distribution."
                )
                return cls._compute_positions(num_images, total, "even", frame_rate)

            if not raw_vals:
                print("LTXAutoSequencer: custom_pattern is empty, falling back to even distribution.")
                return cls._compute_positions(num_images, total, "even", frame_rate)

            positions = []
            for i in range(num_images):
                # Cycle pattern values when fewer than num_images
                v = raw_vals[i % len(raw_vals)]

                if pattern_unit == "normalized_0_to_1":
                    pos = round(v * (total - 1))
                elif pattern_unit == "absolute_seconds":
                    pos = round(v * frame_rate)
                else:  # absolute_frames
                    pos = round(v)

                pos = max(0, min(pos, total - 1))
                positions.append(pos)
            return positions

        # ------ fallback ------
        print(f"LTXAutoSequencer: Unknown distribution_mode '{distribution_mode}', using even.")
        return cls._compute_positions(num_images, total, "even", frame_rate)

    # ------------------------------------------------------------------
    # Execute
    # ------------------------------------------------------------------

    @classmethod
    def execute(
        cls,
        positive,
        negative,
        vae,
        latent,
        images,
        distribution_mode,
        global_strength,
        frame_rate,
        **kwargs,
    ) -> io.NodeOutput:

        scale_factors = vae.downscale_index_formula
        time_scale_factor = scale_factors[0]

        # Work on clones to avoid mutating upstream outputs
        latent_image = latent["samples"].clone()

        if "noise_mask" in latent:
            noise_mask = latent["noise_mask"].clone()
        else:
            batch, _, latent_frames, latent_height, latent_width = latent_image.shape
            noise_mask = torch.ones(
                (batch, 1, latent_frames, 1, 1),
                dtype=torch.float32,
                device=latent_image.device,
            )

        _, _, latent_length, latent_height, latent_width = latent_image.shape

        # Convert latent frames → pixel-space total frame count
        pixel_frame_count = (latent_length - 1) * time_scale_factor + 1

        if images is None or images.shape[0] == 0:
            print("LTXAutoSequencer: No images provided — returning unmodified latent.")
            return io.NodeOutput(
                positive, negative, {"samples": latent_image, "noise_mask": noise_mask}
            )

        num_images = images.shape[0]

        frame_positions = cls._compute_positions(
            num_images, pixel_frame_count, distribution_mode, frame_rate, **kwargs
        )

        print(
            f"LTXAutoSequencer: mode='{distribution_mode}', "
            f"{num_images} image(s), pixel_frames={pixel_frame_count}, "
            f"positions={frame_positions}"
        )

        for i, f_idx in enumerate(frame_positions):
            img = images[i : i + 1]

            image_1, t = cls.encode(vae, latent_width, latent_height, img, scale_factors)

            frame_idx, latent_idx = cls.get_latent_index(
                positive, latent_length, len(image_1), f_idx, scale_factors
            )

            if latent_idx + t.shape[2] > latent_length:
                print(
                    f"LTXAutoSequencer: Image {i + 1} at pixel frame {f_idx} "
                    f"(latent_idx={latent_idx}) would exceed latent length {latent_length} — skipping."
                )
                continue

            positive, negative, latent_image, noise_mask = cls.append_keyframe(
                positive,
                negative,
                frame_idx,
                latent_image,
                noise_mask,
                t,
                global_strength,
                scale_factors,
            )

        return io.NodeOutput(
            positive, negative, {"samples": latent_image, "noise_mask": noise_mask}
        )