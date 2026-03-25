import { app } from "../../scripts/app.js";
import { ComfyWidgets } from "../../scripts/widgets.js";

app.registerExtension({
    name: "Comfy.SpeechLengthCalculator",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "SpeechLengthCalculator") {

            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

                // Add a read-only multiline widget to display the results natively in the node
                const statsWidget = ComfyWidgets["STRING"](this, "Stats", ["STRING", { multiline: true }], app).widget;
                
                // Style the widget so it looks like a stats display and prevent editing
                if (statsWidget.inputEl) {
                    statsWidget.inputEl.readOnly = true;
                    statsWidget.inputEl.style.opacity = "0.9";
                    statsWidget.inputEl.style.backgroundColor = "rgba(0,0,0,0.3)";
                    statsWidget.inputEl.style.fontFamily = "monospace";
                    statsWidget.inputEl.style.pointerEvents = "none";
                    statsWidget.inputEl.style.height = "150px"; // Increased to fit new line
                    statsWidget.inputEl.style.minHeight = "150px";
                    statsWidget.inputEl.style.overflow = "hidden";
                }

                // Explicitly tell LiteGraph how much space this custom widget requires
                statsWidget.computeSize = function() {
                    return [0, 155]; // 150px for the height + 5px padding
                };

                // Force the node to recalculate its dimensions to perfectly fit all widgets.
                requestAnimationFrame(() => {
                    const targetWidth = 400;
                    const targetHeight = 400;
                    
                    if (this.computeSize) {
                        const minSize = this.computeSize([targetWidth, targetHeight]);
                        this.size = [Math.max(targetWidth, minSize[0]), Math.max(targetHeight, minSize[1])];
                    } else {
                        this.size = [targetWidth, targetHeight];
                    }
                    this.setDirtyCanvas(true, true);
                });

                // Helper to fetch the current active text (from connected node OR internal widget)
                this._getCurrentText = () => {
                    // Check if text_input (or a converted text widget) is connected via link
                    const inputSlot = this.inputs && this.inputs.find(i => i.name === "text_input" || (i.name === "text" && i.link));
                    if (inputSlot && inputSlot.link) {
                        const link = app.graph.links[inputSlot.link];
                        if (link) {
                            const sourceNode = app.graph.getNodeById(link.origin_id);
                            if (sourceNode && sourceNode.widgets) {
                                // Search for a text/value widget on the connected node
                                const w = sourceNode.widgets.find(w => w.name === "value" || w.name === "text" || w.name === "Text" || w.type === "customtext" || w.type === "STRING");
                                if (w && typeof w.value === "string") return w.value;
                            }
                        }
                    }
                    // Fallback to our internal text widget
                    const textWidget = this.widgets.find(w => w.name === "text");
                    return textWidget ? (textWidget.value || "") : "";
                };

                // Track the last state so we only recalculate when values actually change
                this._lastState = { text: null, fps: null, addTime: null };

                const updateStats = () => {
                    const fpsWidget = this.widgets.find(w => w.name === "fps");
                    const additionalTimeWidget = this.widgets.find(w => w.name === "additional_time");

                    if (!fpsWidget || !statsWidget) return;

                    const text = this._getCurrentText();
                    const fps = fpsWidget.value || 24;
                    const additionalTime = additionalTimeWidget ? parseFloat(additionalTimeWidget.value) || 0 : 0;

                    // Prevent unnecessary recalculations if nothing has changed
                    if (this._lastState.text === text && 
                        this._lastState.fps === fps && 
                        this._lastState.addTime === additionalTime) {
                        return;
                    }
                    
                    this._lastState.text = text;
                    this._lastState.fps = fps;
                    this._lastState.addTime = additionalTime;

                    // Regex to find words inside standard or smart quotes
                    const regex = /"([^"]*)"|'([^']*)'|“([^”]*)”|‘([^’]*)’/g;
                    let match;
                    let quotedText = "";
                    while ((match = regex.exec(text)) !== null) {
                        quotedText += (match[1] || match[2] || match[3] || match[4] || "") + " ";
                    }

                    // Count words
                    const words = quotedText.trim().split(/\s+/).filter(w => w.length > 0);
                    const wordCount = words.length;

                    if (wordCount === 0 && additionalTime === 0) {
                        statsWidget.value = `Spoken Words: 0\nAdditional Time: 0s\nWPM = Words Per Minute\n(No text inside quotes found)\n(Wrap spoken text in "quotes" to calculate)`;
                        return;
                    }

                    const formatTime = (wpm) => {
                        const baseMins = wordCount / wpm;
                        const totalSecs = (baseMins * 60) + additionalTime;
                        
                        const mins = Math.floor(totalSecs / 60);
                        const secs = Math.round(totalSecs % 60);
                        const frames = Math.ceil(totalSecs * fps);

                        const secsStr = secs.toString().padStart(2, '0');
                        return {
                            time: `${mins}m ${secsStr}s`,
                            frames: frames.toString()
                        };
                    };

                    const slow = formatTime(100);
                    const avg = formatTime(130);
                    const fast = formatTime(160);

                    statsWidget.value = 
`Spoken Words: ${wordCount}
Additional Time: ${additionalTime}s
WPM = Words Per Minute
--------------------------------------------
Speech Speed     Time       Frames
Slow (100 WPM)   ${slow.time.padEnd(10)} ${slow.frames}
Avg  (130 WPM)   ${avg.time.padEnd(10)} ${avg.frames}
Fast (160 WPM)   ${fast.time.padEnd(10)} ${fast.frames}`;
                };

                // Hook into LiteGraph's drawing cycle to actively poll the upstream node
                // This guarantees the display updates if a connected node's text changes
                const onDrawBackground = this.onDrawBackground;
                this.onDrawBackground = function(ctx) {
                    if (onDrawBackground) onDrawBackground.apply(this, arguments);
                    updateStats();
                };

                // Bind initial events to update the stats in real-time natively
                setTimeout(() => {
                    const textWidget = this.widgets.find(w => w.name === "text");
                    const fpsWidget = this.widgets.find(w => w.name === "fps");
                    const additionalTimeWidget = this.widgets.find(w => w.name === "additional_time");

                    // Update on text typing natively
                    if (textWidget && textWidget.inputEl) {
                        textWidget.inputEl.addEventListener("input", updateStats);
                    } else if (textWidget) {
                        const origCallback = textWidget.callback;
                        textWidget.callback = function() {
                            if (origCallback) origCallback.apply(this, arguments);
                            updateStats();
                        }
                    }

                    // Update on FPS changing
                    if (fpsWidget) {
                        const origFpsCallback = fpsWidget.callback;
                        fpsWidget.callback = function() {
                            if (origFpsCallback) origFpsCallback.apply(this, arguments);
                            updateStats();
                        }
                    }
                    
                    // Update on Additional Time changing
                    if (additionalTimeWidget) {
                        const origAddCallback = additionalTimeWidget.callback;
                        additionalTimeWidget.callback = function() {
                            if (origAddCallback) origAddCallback.apply(this, arguments);
                            updateStats();
                        }
                    }

                    // Initial calculation
                    updateStats();
                }, 100);

                return r;
            };
        }
    }
});