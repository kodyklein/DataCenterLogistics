import powerbi from "powerbi-visuals-api";

export type RenderMode = "isometric" | "stack";

export interface BuildingSettings {
  fillColor: string;
  outlineColor: string;
  outlineWidth: number;
  showLabels: boolean;

  // Author knobs (not exec-facing)
  renderMode: RenderMode;   // "isometric" | "stack"
  mechEvery: number;        // every N stories
  showLandscaping: boolean;
  windowDensity: number;    // 1.0 = default
}

export const DefaultSettings: BuildingSettings = {
  fillColor: "#6EA8FE",
  outlineColor: "#1F2937",
  outlineWidth: 2,
  showLabels: true,

  renderMode: "isometric",
  mechEvery: 4,
  showLandscaping: true,
  windowDensity: 1.0
};

export function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings {
  const objects = dataView?.metadata?.objects as any;
  const b = objects?.building ?? {};

  const fill = b.fillColor?.solid?.color ?? DefaultSettings.fillColor;
  const outline = b.outlineColor?.solid?.color ?? DefaultSettings.outlineColor;

  const outlineWidth =
    (typeof b.outlineWidth === "number" ? b.outlineWidth : DefaultSettings.outlineWidth);

  const showLabels =
    (typeof b.showLabels === "boolean" ? b.showLabels : DefaultSettings.showLabels);

  const renderMode: RenderMode =
    (b.renderMode === "stack" || b.renderMode === "isometric")
      ? b.renderMode
      : DefaultSettings.renderMode;

  const mechEvery =
    (typeof b.mechEvery === "number" && b.mechEvery >= 2 ? b.mechEvery : DefaultSettings.mechEvery);

  const showLandscaping =
    (typeof b.showLandscaping === "boolean" ? b.showLandscaping : DefaultSettings.showLandscaping);

  const windowDensity =
    (typeof b.windowDensity === "number" && b.windowDensity > 0 ? b.windowDensity : DefaultSettings.windowDensity);

  return {
    fillColor: fill,
    outlineColor: outline,
    outlineWidth,
    showLabels,
    renderMode,
    mechEvery,
    showLandscaping,
    windowDensity
  };
}