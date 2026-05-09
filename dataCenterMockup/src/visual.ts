"use strict";

import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IDownloadService = powerbi.extensibility.IDownloadService;

import { getSettings } from "./settings";

type RenderState = {
  sqft: number;
  stories: number;
  buildingCount: number;
  acreage: number;
  headline: string;
  subline: string;
  adjustedStories: boolean;
  renderMode: number; // 1=isometric (default wow), 0=footprint+stack
};

export class Visual implements IVisual {
  private host: powerbi.extensibility.visual.IVisualHost;
  private root: HTMLElement;
  private content: HTMLDivElement;

  // Tier 7 export
  private downloadService: IDownloadService;

  // Animation
  private anim?: {
    start: number;
    duration: number;
    from: RenderState;
    to: RenderState;
  };
  private last?: RenderState;

  // last SVG for export
  private lastSvg?: SVGSVGElement;

  constructor(options: VisualConstructorOptions) {
    this.host = options.host;
    this.root = options.element;
    this.downloadService = options.host.downloadService;

    // Root container
    this.root.style.position = "relative";
    this.root.style.width = "100%";
    this.root.style.height = "100%";
    this.root.style.overflow = "hidden";

    // Content container (we clear only this each update)
    this.content = document.createElement("div");
    this.content.style.width = "100%";
    this.content.style.height = "100%";
    this.content.style.position = "relative";
    this.root.appendChild(this.content);

    // Export button
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Download Snapshot";
    btn.style.position = "absolute";
    btn.style.top = "8px";
    btn.style.right = "8px";
    btn.style.zIndex = "10";
    btn.style.padding = "6px 10px";
    btn.style.borderRadius = "8px";
    btn.style.border = "1px solid rgba(0,0,0,0.15)";
    btn.style.background = "white";
    btn.style.cursor = "pointer";
    btn.style.fontFamily = "Segoe UI, sans-serif";
    btn.style.fontSize = "12px";
    btn.onclick = () => {
      void this.exportSnapshot();
    };
    this.root.appendChild(btn);
  }

  public update(options: VisualUpdateOptions): void {
    const viewport = options.viewport;
    const dataView = options.dataViews?.[0];

    // Clear content
    while (this.content.firstChild) {
      this.content.removeChild(this.content.firstChild);
    }
    this.lastSvg = undefined;

    const values = dataView?.categorical?.values;
    if (!values || values.length < 2) {
      this.renderMessage("Add measures for Square Footage and Stories.");
      return;
    }

    // Read measures (safe defaults)
    const sqft = this.findRoleValue(values, "sqft", 2000);
    const storiesRaw = this.findRoleValue(values, "stories", 1);
    const buildingCountRaw = this.findRoleValue(values, "buildingCount", 1);
    const acreageRaw = this.findRoleValue(values, "acreage", 0);

    // Guardrails
    const MIN_STORIES = 1;
    const MAX_STORIES = 20;
    const MIN_FLOOR_AREA = 100;
    const MIN_BUILDINGS = 1;
    const MAX_BUILDINGS = 20;

    if (!Number.isFinite(sqft) || sqft <= 0) {
      this.renderMessage("Square Footage must be a positive number.");
      return;
    }

    const buildingCount = clampInt(buildingCountRaw, MIN_BUILDINGS, MAX_BUILDINGS);

    let stories = clampInt(storiesRaw, MIN_STORIES, MAX_STORIES);

    const maxStoriesByFloorArea = Math.max(MIN_STORIES, Math.floor(sqft / MIN_FLOOR_AREA));
    const adjustedStories = stories > maxStoriesByFloorArea;
    stories = Math.min(stories, maxStoriesByFloorArea, MAX_STORIES);

    const acreage = Math.max(0, acreageRaw);

    // Labels (2C)
    const floorPlate = sqft / stories;
    const headline = `${fmt(sqft)} SqFt • ${stories} Stories • ${fmt(Math.round(floorPlate))} SqFt/Floor`;
    const subline =
      `Buildings: ${buildingCount}` +
      (acreage ? ` • Site: ${fmt(Math.round(acreage))} acres` : "") +
      (adjustedStories ? " • ⚠ Adjusted for min floor area" : "");

    const s = getSettings(dataView);

    // Default renderMode to isometric (1) for wow
    const renderMode = typeof (s as any).renderMode === "number" ? (s as any).renderMode : 1;

    const next: RenderState = {
      sqft,
      stories,
      buildingCount,
      acreage,
      headline,
      subline,
      adjustedStories,
      renderMode
    };

    // First render (no animation)
    if (!this.last) {
      this.last = next;
      this.renderFrame(viewport, s, next);
      return;
    }

    const modeChanged = this.last.renderMode !== next.renderMode;
    if (modeChanged) {
      this.last = next;
      this.renderFrame(viewport, s, next);
      return;
    }

    // Animate transitions
    this.anim = {
      start: performance.now(),
      duration: 850,
      from: this.last,
      to: next
    };

    this.tick(viewport, s);
  }

  // Animation loop
  private tick(viewport: powerbi.IViewport, s: any): void {
    if (!this.anim) return;

    const now = performance.now();
    const t = Math.min(1, (now - this.anim.start) / this.anim.duration);
    const e = easeInOutCubic(t);

    const cur: RenderState = {
      sqft: lerp(this.anim.from.sqft, this.anim.to.sqft, e),
      stories: lerp(this.anim.from.stories, this.anim.to.stories, e),
      buildingCount: lerp(this.anim.from.buildingCount, this.anim.to.buildingCount, e),
      acreage: lerp(this.anim.from.acreage, this.anim.to.acreage, e),
      headline: this.anim.to.headline,
      subline: this.anim.to.subline,
      adjustedStories: this.anim.to.adjustedStories,
      renderMode: this.anim.to.renderMode
    };

    while (this.content.firstChild) {
      this.content.removeChild(this.content.firstChild);
    }
    this.renderFrame(viewport, s, cur);

    if (t < 1) {
      requestAnimationFrame(() => this.tick(viewport, s));
    } else {
      this.last = this.anim.to;
      this.anim = undefined;
    }
  }

  // Render a single frame (supports multiple buildings)
  private renderFrame(viewport: powerbi.IViewport, s: any, state: RenderState): void {
    const padding = 16;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("width", `${viewport.width}`);
    svg.setAttribute("height", `${viewport.height}`);
    svg.style.overflow = "hidden";
    this.lastSvg = svg;

    const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("transform", `translate(${padding}, ${padding})`);
    svg.appendChild(g);

    const usableW = Math.max(10, viewport.width - padding * 2);
    const usableH = Math.max(10, viewport.height - padding * 2);

    // Labels zone
    const labelH = s.showLabels ? 46 : 0;
    const sceneTop = labelH + 8;
    const sceneH = Math.max(10, usableH - sceneTop);

    if (s.showLabels) {
      this.drawText(g, state.headline, usableW / 2, 16, { size: 13, weight: "600", color: "#111827" });
      this.drawText(g, state.subline, usableW / 2, 36, { size: 11, weight: "400", color: "#374151" });
    }

    // acreage influence (subtle spacing only)
    const spacingMul = clamp(0.9, 1.35, 1 + Math.log10(state.acreage + 1) / 12);

    // Grid layout for N buildings
    const n = clampInt(state.buildingCount, 1, 20);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const cellW = usableW / cols;
    const cellH = sceneH / rows;

    for (let idx = 0; idx < n; idx++) {
      const r = Math.floor(idx / cols);
      const c = idx % cols;

      const ox = c * cellW;
      const oy = sceneTop + r * cellH;

      const cg = document.createElementNS("http://www.w3.org/2000/svg", "g");
      cg.setAttribute("transform", `translate(${ox}, ${oy})`);
      g.appendChild(cg);

      const innerPad = 10 * spacingMul;
      const w = Math.max(40, cellW - innerPad * 2);
      const h = Math.max(40, cellH - innerPad * 2);

      const cx = innerPad + w / 2;
      const cy = innerPad + h / 2;

      if (state.renderMode === 1) {
        this.renderIsometric(cg, cx, cy, w, h, state, s);
      } else {
        this.renderFootprintStack(cg, innerPad, innerPad, w, h, state, s);
      }
    }

    this.content.appendChild(svg);
  }

  // Renderers
  private renderFootprintStack(
    g: SVGGElement,
    x0: number,
    y0: number,
    w: number,
    h: number,
    state: RenderState,
    s: any
  ): void {
    const footprintZoneH = h * 0.55;
    const heightZoneH = h * 0.45;

    const footprintArea = Math.max(1, state.sqft / state.stories);
    const ar = Math.max(0.2, s.aspectRatio ?? 1.6);
    const fw = Math.sqrt(footprintArea * ar);
    const fd = footprintArea / fw;

    const scale = Math.min(w / fw, footprintZoneH / fd);

    const baseW = fw * scale;
    const baseD = fd * scale;

    const baseX = x0 + (w - baseW) / 2;
    const baseY = y0 + footprintZoneH - baseD;

    const baseRect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    baseRect.setAttribute("x", `${baseX}`);
    baseRect.setAttribute("y", `${baseY}`);
    baseRect.setAttribute("width", `${baseW}`);
    baseRect.setAttribute("height", `${baseD}`);
    baseRect.setAttribute("rx", "10");
    baseRect.setAttribute("fill", s.fillColor);
    baseRect.setAttribute("stroke", s.outlineColor);
    baseRect.setAttribute("stroke-width", `${s.outlineWidth}`);
    g.appendChild(baseRect);

    const floors = Math.min(200, Math.round(state.stories));
    const floorH = Math.max(2, heightZoneH / Math.max(1, floors));

    const stackX = baseX + baseW * 0.15;
    const stackW = baseW * 0.70;
    const stackTopY = y0 + footprintZoneH + 8 + heightZoneH;

    for (let i = 0; i < floors; i++) {
      const y = stackTopY - (i + 1) * floorH;

      const rr = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rr.setAttribute("x", `${stackX}`);
      rr.setAttribute("y", `${y}`);
      rr.setAttribute("width", `${stackW}`);
      rr.setAttribute("height", `${floorH - 0.5}`);
      rr.setAttribute("fill", this.tint(s.fillColor, i / Math.max(1, floors)));
      rr.setAttribute("stroke", s.outlineColor);
      rr.setAttribute("stroke-width", `${Math.max(1, s.outlineWidth * 0.6)}`);
      rr.setAttribute("rx", "6");
      g.appendChild(rr);
    }
  }

  private renderIsometric(
    g: SVGGElement,
    cx: number,
    cy: number,
    w: number,
    h: number,
    state: RenderState,
    s: any
  ): void {
    const base = Math.min(w, h) * 0.32 + Math.sqrt(state.sqft / state.stories) * 0.02;
    const height = Math.min(h * 0.7, Math.max(30, state.stories * 6));

    const shadow = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    shadow.setAttribute("cx", `${cx}`);
    shadow.setAttribute("cy", `${cy + height * 0.65}`);
    shadow.setAttribute("rx", `${base * 1.05}`);
    shadow.setAttribute("ry", `${base * 0.45}`);
    shadow.setAttribute("fill", "rgba(0,0,0,0.10)");
    g.appendChild(shadow);

    const top: [number, number][] = [
      [cx, cy - base],
      [cx + base, cy - base * 0.5],
      [cx, cy],
      [cx - base, cy - base * 0.5]
    ];

    const front: [number, number][] = [
      [cx - base, cy - base * 0.5],
      [cx, cy],
      [cx, cy + height],
      [cx - base, cy + height - base * 0.5]
    ];

    const side: [number, number][] = [
      [cx, cy],
      [cx + base, cy - base * 0.5],
      [cx + base, cy + height - base * 0.5],
      [cx, cy + height]
    ];

    this.poly(g, top, this.tint(s.fillColor, 0.25), s);
    this.poly(g, side, this.tint(s.fillColor, 0.45), s);
    this.poly(g, front, s.fillColor, s);

    const edge = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    edge.setAttribute("points", `${top[0][0]},${top[0][1]} ${top[1][0]},${top[1][1]} ${side[2][0]},${side[2][1]}`);
    edge.setAttribute("fill", "none");
    edge.setAttribute("stroke", "rgba(255,255,255,0.55)");
    edge.setAttribute("stroke-width", "1");
    g.appendChild(edge);
  }

  private poly(g: SVGGElement, pts: [number, number][], fill: string, s: any): void {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    p.setAttribute("points", pts.map(d => `${d[0]},${d[1]}`).join(" "));
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", s.outlineColor);
    p.setAttribute("stroke-width", `${Math.max(1, s.outlineWidth * 0.7)}`);
    p.setAttribute("stroke-linejoin", "round");
    g.appendChild(p);
  }

  private drawText(
    g: SVGGElement,
    text: string,
    x: number,
    y: number,
    opts: { size: number; weight: string; color: string }
  ): void {
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", `${x}`);
    t.setAttribute("y", `${y}`);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("fill", opts.color);
    t.setAttribute("font-family", "Segoe UI, sans-serif");
    t.setAttribute("font-size", `${opts.size}`);
    t.setAttribute("font-weight", opts.weight);
    t.textContent = text;
    g.appendChild(t);
  }

  // Tier 7: Export SVG + inputs JSON
  private async exportSnapshot(): Promise<void> {
    try {
      if (!this.lastSvg || !this.last) return;

      const status = await this.downloadService.exportStatus();
      if (status !== powerbi.PrivilegeStatus.Allowed) {
        // tenant/admin may block this; do nothing
        return;
      }

      const serializer = new XMLSerializer();
      const svgXml = serializer.serializeToString(this.lastSvg);

      await this.downloadService.exportVisualsContent(
        svgXml,
        "DataCenterMockup.xml",
        "xml",
        "Data center mockup (SVG as XML)"
      );

      const inputs = JSON.stringify(
        {
          sqft: this.last.sqft,
          stories: this.last.stories,
          buildingCount: this.last.buildingCount,
          acreage: this.last.acreage,
          renderMode: this.last.renderMode
        },
        null,
        2
      );

      await this.downloadService.exportVisualsContent(
        inputs,
        "DataCenterMockupInputs.json",
        "json",
        "Input parameters"
      );
    } catch {
      // swallow errors quietly
    }
  }

  private findRoleValue(values: powerbi.DataViewValueColumns, roleName: string, fallback: number): number {
    const col = values.find(v => (v.source?.roles as any)?.[roleName]);
    const v = col?.values?.[0] as any;
    const num = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(num) ? num : fallback;
  }

  private renderMessage(msg: string): void {
    const d = document.createElement("div");
    d.style.padding = "12px";
    d.style.fontFamily = "Segoe UI, sans-serif";
    d.style.fontSize = "12px";
    d.style.color = "#374151";
    d.textContent = msg;
    this.content.appendChild(d);
  }

  private tint(hex: string, t: number): string {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16);
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const mix = (v: number) => Math.round(v + (255 - v) * Math.min(0.6, t * 0.6));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }
}

// Helpers
function clampInt(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function clamp(min: number, max: number, x: number): number {
  return Math.max(min, Math.min(max, x));
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}