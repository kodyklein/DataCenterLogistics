import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
export declare class Visual implements IVisual {
    private root;
    private content;
    private lastSvg?;
    private downloadService;
    constructor(options: VisualConstructorOptions);
    update(options: VisualUpdateOptions): void;
    private buildMeasureMap;
    private parseInputs;
    private matchBuildingParam;
    private computeScenario;
    private render;
    private expandGlobal;
    private drawGrassPlane;
    private drawHedges;
    private renderFootprintStack;
    private renderIsometricDatacenter;
    private drawFooter;
    private poly;
    private drawText;
    private renderMessage;
    private exportSnapshot;
    private tint;
}
