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

export const DefaultSettings: BuildingSettings = {
  fillColor: "#6EA8FE",
  outlineColor: "#1F2937",
  outlineWidth: 2,
  showLabels: true,

  renderMode: "isometric",
  mechEvery: 4,
  showLandscaping: true,
  windowDensity: 1.0,

  textHdr1: { size: 14, bold: true, italic: false, underline: false, align: "center", wrap: false },
  textSub1: { size: 11, bold: false, italic: false, underline: false, align: "center", wrap: false },
  textHdr2: { size: 16, bold: true, italic: false, underline: false, align: "center", wrap: false },
  textBody: { size: 12, bold: false, italic: false, underline: false, align: "center", wrap: false },
  textWarn: { size: 11, bold: false, italic: false, underline: false, align: "center", wrap: true }
};

export function getSettings(dataView: powerbi.DataView | undefined): BuildingSettings {
  const objects = dataView?.metadata?.objects as any;
  const b = objects?.building ?? {};
  const t = objects?.text ?? {};

  const fill = b.fillColor?.solid?.color ?? DefaultSettings.fillColor;
  const outline = b.outlineColor?.solid?.color ?? DefaultSettings.outlineColor;

  const outlineWidth = (typeof b.outlineWidth === "number" ? b.outlineWidth : DefaultSettings.outlineWidth);
  const showLabels = (typeof b.showLabels === "boolean" ? b.showLabels : DefaultSettings.showLabels);

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

  const readAlign = (v: any, fallback: TextAlign): TextAlign =>
    (v === "left" || v === "center" || v === "right") ? v : fallback;

  const readStyle = (prefix: string, fallback: TextStyle): TextStyle => {
    const size = (typeof t[`${prefix}_size`] === "number" && t[`${prefix}_size`] > 0) ? t[`${prefix}_size`] : fallback.size;
    const bold = (typeof t[`${prefix}_bold`] === "boolean") ? t[`${prefix}_bold`] : fallback.bold;
    const italic = (typeof t[`${prefix}_italic`] === "boolean") ? t[`${prefix}_italic`] : fallback.italic;
    const underline = (typeof t[`${prefix}_underline`] === "boolean") ? t[`${prefix}_underline`] : fallback.underline;
    const align = readAlign(t[`${prefix}_align`], fallback.align);
    const wrap = (typeof t[`${prefix}_wrap`] === "boolean") ? t[`${prefix}_wrap`] : fallback.wrap;
    return { size, bold, italic, underline, align, wrap };
  };

  return {
    fillColor: fill,
    outlineColor: outline,
    outlineWidth,
    showLabels,
    renderMode,
    mechEvery,
    showLandscaping,
    windowDensity,

    textHdr1: readStyle("hdr1", DefaultSettings.textHdr1),
    textSub1: readStyle("sub1", DefaultSettings.textSub1),
    textHdr2: readStyle("hdr2", DefaultSettings.textHdr2),
    textBody: readStyle("body", DefaultSettings.textBody),
    textWarn: readStyle("warn", DefaultSettings.textWarn)
  };
}