import powerbi from "powerbi-visuals-api";
export type RenderMode = "isometric" | "stack";
export interface BuildingSettings {
    fillColor: string;
    outlineColor: string;
    outlineWidth: number;
    showLabels: boolean;
    renderMode: RenderMode;
    mechEvery: number;
    showLandscaping: boolean;
    windowDensity: number;
}
export declare const DefaultSettings: BuildingSettings;
export declare function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings;
