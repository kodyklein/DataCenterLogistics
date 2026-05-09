import powerbi from "powerbi-visuals-api";
export interface BuildingSettings {
    fillColor: string;
    outlineColor: string;
    outlineWidth: number;
    aspectRatio: number;
    showLabels: boolean;
}
export declare const DefaultSettings: BuildingSettings;
export declare function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings;
