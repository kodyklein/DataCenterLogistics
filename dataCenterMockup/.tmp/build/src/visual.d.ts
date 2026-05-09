import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
export declare class Visual implements IVisual {
    private host;
    private root;
    private content;
    private downloadService;
    private anim?;
    private last?;
    private lastSvg?;
    constructor(options: VisualConstructorOptions);
    update(options: VisualUpdateOptions): void;
    private tick;
    private renderFrame;
    private renderFootprintStack;
    private renderIsometric;
    private poly;
    private drawText;
    private exportSnapshot;
    private findRoleValue;
    private renderMessage;
    private tint;
}
