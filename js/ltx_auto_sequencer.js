import { app } from "../../scripts/app.js";

// Widgets only relevant to specific distribution modes
const FIXED_INTERVAL_WIDGETS = ["interval", "interval_unit"];
const CUSTOM_PATTERN_WIDGETS = ["custom_pattern", "pattern_unit"];

/**
 * ComfyUI native trick: hide/show a widget without removing it from the node.
 * Collapsed widgets take up -4px (absorbs LiteGraph's 4px margin).
 */
function toggleWidget(widget, visible) {
    if (visible) {
        if (widget.origType !== undefined) {
            widget.type = widget.origType;
            widget.computeSize = widget.origComputeSize;
            delete widget.origType;
            delete widget.origComputeSize;
        }
    } else {
        if (widget.type !== "hidden") {
            widget.origType = widget.type;
            widget.origComputeSize = widget.computeSize;
            widget.type = "hidden";
            widget.computeSize = () => [0, -4];
        }
    }
}

app.registerExtension({
    name: "Comfy.LTXAutoSequencer.DynamicVisibility",

    async nodeCreated(node) {
        if (node.comfyClass !== "LTXAutoSequencer") return;

        // ---------------------------------------------------------------
        // Core visibility update: show only widgets relevant to the
        // currently selected distribution_mode.
        // ---------------------------------------------------------------
        node._updateAutoSeqVisibility = function () {
            const modeWidget = this.widgets?.find(w => w.name === "distribution_mode");
            if (!modeWidget) return;
            const mode = modeWidget.value;

            let changed = false;
            for (const w of this.widgets) {
                let shouldBeVisible = true;

                if (FIXED_INTERVAL_WIDGETS.includes(w.name)) {
                    shouldBeVisible = (mode === "fixed_interval");
                } else if (CUSTOM_PATTERN_WIDGETS.includes(w.name)) {
                    shouldBeVisible = (mode === "custom_pattern");
                }

                const isHidden = (w.type === "hidden");
                if (shouldBeVisible && isHidden) {
                    toggleWidget(w, true);
                    changed = true;
                } else if (!shouldBeVisible && !isHidden) {
                    toggleWidget(w, false);
                    changed = true;
                }
            }

            if (changed) {
                this.setDirtyCanvas(true, true);
                requestAnimationFrame(() => {
                    if (this.computeSize) this.setSize(this.computeSize());
                });
            }
        };

        // ---------------------------------------------------------------
        // Hook the distribution_mode combo so visibility updates
        // immediately when the user changes the dropdown.
        // ---------------------------------------------------------------
        const hookModeWidget = () => {
            const modeWidget = node.widgets?.find(w => w.name === "distribution_mode");
            if (modeWidget && !modeWidget._autoSeqHooked) {
                const origCallback = modeWidget.callback;
                modeWidget.callback = function (val) {
                    node._updateAutoSeqVisibility();
                    if (origCallback) origCallback.call(this, val);
                };
                modeWidget._autoSeqHooked = true;

                // Run immediately so the initial state is correct
                node._updateAutoSeqVisibility();
            }
        };

        // Widgets may not be ready synchronously on nodeCreated
        setTimeout(hookModeWidget, 50);

        // ---------------------------------------------------------------
        // Re-apply visibility after graph load / undo-redo / configure
        // ---------------------------------------------------------------
        node.onConfigure = function (info) {
            setTimeout(() => {
                hookModeWidget();
                node._updateAutoSeqVisibility();
            }, 100);
        };
    }
});