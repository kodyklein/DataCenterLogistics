import powerbi from "powerbi-visuals-api";
export type RenderMode = "isometric" | "stack";
export type TextAlign = "left" | "center" | "right";
export interface TextStyle {
    size: number;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    align: TextAlign;
    wrap: boolean;
}
export interface BuildingSettings {
    fillColor: string;
    outlineColor: string;
    outlineWidth: number;
    showLabels: boolean;
    renderMode: RenderMode;
    mechEvery: number;
    showLandscaping: boolean;
    windowDensity: number;
    textHdr1: TextStyle;
    textSub1: TextStyle;
    textHdr2: TextStyle;
    textBody: TextStyle;
    textWarn: TextStyle;
}
export declare const DefaultSettings: BuildingSettings;
export declare function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings;
