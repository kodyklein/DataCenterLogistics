import powerbi from "powerbi-visuals-api";

export interface BuildingSettings {
  fillColor: string;
  outlineColor: string;
  outlineWidth: number;
  aspectRatio: number;
  showLabels: boolean;
}

export const DefaultSettings: BuildingSettings = {
  fillColor: "#6EA8FE",
  outlineColor: "#1F2937",
  outlineWidth: 2,
  aspectRatio: 1.6,
  showLabels: true
};

export function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings {
  const objects = dataView?.metadata?.objects as any;
  const b = objects?.building ?? {};

  const fill = b.fillColor?.solid?.color ?? DefaultSettings.fillColor;
  const outline = b.outlineColor?.solid?.color ?? DefaultSettings.outlineColor;
  const outlineWidth = (typeof b.outlineWidth === "number" ? b.outlineWidth : DefaultSettings.outlineWidth);
  const aspectRatio = (typeof b.aspectRatio === "number" && b.aspectRatio > 0 ? b.aspectRatio : DefaultSettings.aspectRatio);
  const showLabels = (typeof b.showLabels === "boolean" ? b.showLabels : DefaultSettings.showLabels);

  return { fillColor: fill, outlineColor: outline, outlineWidth, aspectRatio, showLabels };
}