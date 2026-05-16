"use strict";

import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;

import IDownloadService = powerbi.extensibility.IDownloadService;
import VisualObjectInstance = powerbi.VisualObjectInstance;

import { getSettings, DefaultSettings, BuildingSettings } from "./settings";

type BuildingSpec = { sqft: number; stories: number };
type Pt = { x: number; y: number };

type Inputs = {
  mode: number; // 0=Global, 1=Individual
  acreage: number;
  totalSqft: number;
  storiesGlobal: number;
  buildingCountGlobal: number;
  buildings: BuildingSpec[];
  hoursPerDay: number;
  daysPerWeek: number;
  gates: number;
  projectMonths: number;
  stagingArea: boolean; // Staging Area measure >=0.5 => Y
};

type RenderState = {
  inputs: Inputs;
  hdr1: string;
  sub1: string;
  totalBuildings: number;
  totalSqftAllBuildings: number;
  totalTrucks: number;
  buildingTrucks: number;
  infraTrucks: number;
  avgTrucksPerReceivingDay?: number;
  trucksPerHourPerGate?: number;
  throughputThreshold?: number;
  isThroughputHigh?: boolean;
  securityStaffMin?: number;
  securityStaffMax?: number;
};

export class Visual implements IVisual {
  private root: HTMLElement;
  private content: HTMLDivElement;
  private lastSvg?: SVGSVGElement;
  private downloadService: IDownloadService;

  // Store current settings so enumerateObjectInstances can expose them
  private settings: BuildingSettings = DefaultSettings;

  constructor(options: VisualConstructorOptions) {
    this.root = options.element;
    this.downloadService = options.host.downloadService;

    this.root.style.position = "relative";
    this.root.style.width = "100%";
    this.root.style.height = "100%";
    this.root.style.overflow = "hidden";

    this.content = document.createElement("div");
    this.content.style.width = "100%";
    this.content.style.height = "100%";
    this.content.style.position = "relative";
    this.root.appendChild(this.content);

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
    btn.onclick = () => void this.exportSnapshot();
    this.root.appendChild(btn);
  }

  // ✅ THIS is what makes the Format pane show your capabilities objects.
  public enumerateObjectInstances(options: EnumerateVisualObjectInstancesOptions): VisualObjectInstance[] {
    const s = this.settings ?? DefaultSettings;

    if (options.objectName === "building") {
      return [{
        objectName: "building",
        selector: null as any,
        properties: {
          fillColor: { solid: { color: s.fillColor } },
          outlineColor: { solid: { color: s.outlineColor } },
          outlineWidth: s.outlineWidth,
          showLabels: s.showLabels,
          renderMode: s.renderMode,
          mechEvery: s.mechEvery,
          showLandscaping: s.showLandscaping, // still exposed, but landscaping drawing is commented out in render
          windowDensity: s.windowDensity
        }
      }];
    }

    if (options.objectName === "text") {
      return [{
        objectName: "text",
        selector: null as any,
        properties: {
          hdr1_size: s.textHdr1.size,
          hdr1_bold: s.textHdr1.bold,
          hdr1_italic: s.textHdr1.italic,
          hdr1_underline: s.textHdr1.underline,
          hdr1_align: s.textHdr1.align,
          hdr1_wrap: s.textHdr1.wrap,

          sub1_size: s.textSub1.size,
          sub1_bold: s.textSub1.bold,
          sub1_italic: s.textSub1.italic,
          sub1_underline: s.textSub1.underline,
          sub1_align: s.textSub1.align,
          sub1_wrap: s.textSub1.wrap,

          hdr2_size: s.textHdr2.size,
          hdr2_bold: s.textHdr2.bold,
          hdr2_italic: s.textHdr2.italic,
          hdr2_underline: s.textHdr2.underline,
          hdr2_align: s.textHdr2.align,
          hdr2_wrap: s.textHdr2.wrap,

          body_size: s.textBody.size,
          body_bold: s.textBody.bold,
          body_italic: s.textBody.italic,
          body_underline: s.textBody.underline,
          body_align: s.textBody.align,
          body_wrap: s.textBody.wrap,

          warn_size: s.textWarn.size,
          warn_bold: s.textWarn.bold,
          warn_italic: s.textWarn.italic,
          warn_underline: s.textWarn.underline,
          warn_align: s.textWarn.align,
          warn_wrap: s.textWarn.wrap
        }
      }];
    }

    return [];
  }

  public update(options: VisualUpdateOptions): void {
    while (this.content.firstChild) this.content.removeChild(this.content.firstChild);
    this.lastSvg = undefined;

    const viewport = options.viewport;
    const dataView = options.dataViews?.[0];
    const values = dataView?.categorical?.values;

    if (!values || values.length < 1) {
      this.renderMessage("Drop your input measures into the visual.");
      return;
    }

    const s = getSettings(dataView);
    this.settings = s; // keep for enumerateObjectInstances

    const measureMap = this.buildMeasureMap(values);
    const inputs = this.parseInputs(measureMap);
    const state = this.computeScenario(inputs);

    this.render(viewport, s, state);
  }

  // ----------------------------
  // Parsing
  // ----------------------------
  private buildMeasureMap(values: powerbi.DataViewValueColumns): Map<string, number> {
    const m = new Map<string, number>();
    for (const col of values) {
      const name = (col.source?.displayName ?? col.source?.queryName ?? "").toString().trim();
      const raw = col.values?.[0] as any;
      const num = typeof raw === "number" ? raw : parseFloat(raw);
      if (name) m.set(name, Number.isFinite(num) ? num : 0);
    }
    return m;
  }

  private parseInputs(measures: Map<string, number>): Inputs {
    const get = (keys: (string | RegExp)[], fallback = 0): number => {
      for (const k of keys) {
        if (typeof k === "string") {
          if (measures.has(k)) return measures.get(k)!;
        } else {
          for (const [name, val] of measures) if (k.test(name)) return val;
        }
      }
      return fallback;
    };

    const mode = clampInt(get([/^mode$/i], 0), 0, 1);
    const acreage = Math.max(0, get([/^acreage$/i], 0));
    const totalSqft = Math.max(0, get([/^total\s*sqft$/i, /^total\s*square\s*foot/i], 0));
    const storiesGlobal = Math.max(0, get([/^stories$/i, /^stories\s*per\s*building$/i], 0));
    const buildingCountGlobal = Math.max(0, get([/^building\s*count$/i, /^buildings$/i], 0));
    const hoursPerDay = Math.max(0, get([/^hours\s*per\s*day$/i], 0));
    const daysPerWeek = Math.max(0, get([/^days\s*per\s*week$/i], 0));
    const gates = Math.max(0, get([/^receiving\s*gates$/i, /^gates$/i], 0));

    const weeksPerMonth = 4.345;
    const projectMonthsDirect = Math.max(0, get([/^project\s*months$/i], 0));
    const projectWeeksFallback = Math.max(0, get([/^project\s*weeks$/i], 0));
    const projectMonths =
      projectMonthsDirect > 0
        ? projectMonthsDirect
        : (projectWeeksFallback > 0 ? projectWeeksFallback / weeksPerMonth : 0);

    const stagingAreaVal = Math.max(0, get([/^staging\s*area$/i], 0));
    const stagingArea = stagingAreaVal >= 0.5;

    // Individual buildings (up to 10)
    const perSqft = new Array(10).fill(0);
    const perStories = new Array(10).fill(0);

    for (const [name, val] of measures) {
      const b = this.matchBuildingParam(name);
      if (!b) continue;
      const idx = b.index - 1;
      if (idx < 0 || idx >= 10) continue;
      if (b.kind === "sqft") perSqft[idx] = Math.max(0, val);
      if (b.kind === "stories") perStories[idx] = Math.max(0, val);
    }

    const buildings: BuildingSpec[] = [];
    for (let i = 0; i < 10; i++) {
      if (perSqft[i] > 0 && perStories[i] > 0) buildings.push({ sqft: perSqft[i], stories: perStories[i] });
    }

    return {
      mode,
      acreage,
      totalSqft,
      storiesGlobal,
      buildingCountGlobal,
      buildings,
      hoursPerDay,
      daysPerWeek,
      gates,
      projectMonths,
      stagingArea
    };
  }

  private matchBuildingParam(name: string): { index: number; kind: "sqft" | "stories" } | null {
    const n = name.trim();

    // e.g. "Building 1 Sqft", "B1 Stories"
    let m = n.match(/^b(?:uilding)?\s*0*([1-9]|10)\s*(sqft|square\s*foot(age)?|stories)$/i);
    if (m) {
      const index = parseInt(m[1], 10);
      const tail = m[2].toLowerCase();
      return { index, kind: tail.startsWith("stor") ? "stories" : "sqft" };
    }

    m = n.match(/^building\s*0*([1-9]|10)\s*(sqft|square\s*foot(age)?|stories)$/i);
    if (m) {
      const index = parseInt(m[1], 10);
      const tail = m[2].toLowerCase();
      return { index, kind: tail.startsWith("stor") ? "stories" : "sqft" };
    }

    // e.g. "Sqft_Building_1" or "Stories-Bldg-2"
    m = n.match(/^(sqft|stories)\s*[_-]?\s*(bldg|building)\s*[_-]?\s*0*([1-9]|10)$/i);
    if (m) {
      const kind = m[1].toLowerCase() === "stories" ? "stories" : "sqft";
      const index = parseInt(m[3], 10);
      return { index, kind };
    }

    return null;
  }

  // ----------------------------
  // Scenario + business math
  // ----------------------------
  private computeScenario(inputs: Inputs): RenderState {
    const MIN_STORIES = 1;
    const MAX_STORIES = 20;
    const MIN_FLOOR_AREA = 100;

    const TRUCKS_PER_SQFT = 0.044;
    const TRUCKS_PER_ACRE = 18;

    const THRESHOLD_WITH_STAGING = 30;
    const THRESHOLD_NO_STAGING = 6;

    let buildings: BuildingSpec[] = [];
    let totalSqftAllBuildings = 0;

    if (inputs.mode === 1) {
      buildings = inputs.buildings.map(b => ({ sqft: b.sqft, stories: clampInt(b.stories, MIN_STORIES, MAX_STORIES) }));
      buildings = buildings.map(b => {
        const maxStoriesByFloor = Math.max(MIN_STORIES, Math.floor(b.sqft / MIN_FLOOR_AREA));
        const stories = Math.min(b.stories, maxStoriesByFloor, MAX_STORIES);
        return { sqft: b.sqft, stories };
      });
      totalSqftAllBuildings = buildings.reduce((acc, b) => acc + b.sqft, 0);
    } else {
      const bCount = clampInt(inputs.buildingCountGlobal || 1, 1, 20);
      const stories = clampInt(inputs.storiesGlobal || 1, MIN_STORIES, MAX_STORIES);
      const sqftPerBuilding = bCount > 0 ? inputs.totalSqft / bCount : 0;

      buildings = new Array(bCount).fill(0).map(() => ({ sqft: Math.max(0, sqftPerBuilding), stories }));
      buildings = buildings.map(b => {
        const maxStoriesByFloor = Math.max(MIN_STORIES, Math.floor(b.sqft / MIN_FLOOR_AREA));
        return { sqft: b.sqft, stories: Math.min(b.stories, maxStoriesByFloor, MAX_STORIES) };
      });
      totalSqftAllBuildings = inputs.totalSqft;
    }

    const totalBuildings = buildings.length;
    const hdr1 = inputs.mode === 1
      ? `Individual Mode • Buildings Configured: ${totalBuildings}`
      : `Global Mode • ${totalBuildings} Buildings`;

    const sub1 = `Total SqFt: ${fmt(Math.round(totalSqftAllBuildings))} • Site: ${fmt(Math.round(inputs.acreage))} acres`;

    const buildingTrucks = Math.ceil(totalSqftAllBuildings * TRUCKS_PER_SQFT);
    const infraTrucks = Math.ceil(inputs.acreage * TRUCKS_PER_ACRE);
    const totalTrucks = buildingTrucks + infraTrucks;

    // Throughput
    let avgTrucksPerReceivingDay: number | undefined;
    let trucksPerHourPerGate: number | undefined;

    const weeksPerMonth = 4.345;
    if (inputs.projectMonths > 0 && inputs.daysPerWeek > 0) {
      const receivingDays = inputs.projectMonths * weeksPerMonth * inputs.daysPerWeek;
      if (receivingDays > 0) avgTrucksPerReceivingDay = totalTrucks / receivingDays;
    }

    if (avgTrucksPerReceivingDay !== undefined && inputs.hoursPerDay > 0 && inputs.gates > 0) {
      trucksPerHourPerGate = avgTrucksPerReceivingDay / (inputs.hoursPerDay * inputs.gates);
    }

    const throughputThreshold = inputs.stagingArea ? THRESHOLD_WITH_STAGING : THRESHOLD_NO_STAGING;
    const isThroughputHigh = trucksPerHourPerGate !== undefined ? (trucksPerHourPerGate > throughputThreshold) : false;

    // Staffing assumptions
    const STAFF_PER_GATE_AT_ALL_TIMES = 2;
    const MIN_HOURS_PER_STAFF_PER_WEEK = 30;
    const MAX_HOURS_PER_STAFF_PER_WEEK = 50;

    const weeklyCoverageHours = (inputs.hoursPerDay > 0 && inputs.daysPerWeek > 0)
      ? (inputs.hoursPerDay * inputs.daysPerWeek)
      : 0;

    let securityStaffMin: number | undefined;
    let securityStaffMax: number | undefined;

    if (inputs.gates > 0 && weeklyCoverageHours > 0) {
      const requiredStaffHoursPerWeek = inputs.gates * STAFF_PER_GATE_AT_ALL_TIMES * weeklyCoverageHours;
      securityStaffMin = Math.ceil(requiredStaffHoursPerWeek / MAX_HOURS_PER_STAFF_PER_WEEK);
      securityStaffMax = Math.ceil(requiredStaffHoursPerWeek / MIN_HOURS_PER_STAFF_PER_WEEK);
    }

    return {
      inputs,
      hdr1,
      sub1,
      totalBuildings,
      totalSqftAllBuildings,
      totalTrucks,
      buildingTrucks,
      infraTrucks,
      avgTrucksPerReceivingDay,
      trucksPerHourPerGate,
      throughputThreshold,
      isThroughputHigh,
      securityStaffMin,
      securityStaffMax
    };
  }

  // ----------------------------
  // Rendering
  // ----------------------------
  private render(viewport: powerbi.IViewport, s: BuildingSettings, state: RenderState): void {
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

    const footerH = Math.max(140, Math.floor(usableH * 0.25));
    const headerH = s.showLabels ? 54 : 0;

    const sceneTop = headerH + 6;
    const sceneH = Math.max(10, usableH - headerH - footerH);

    // Top labels
    if (s.showLabels) {
      this.drawTextBlock(g, state.hdr1, usableW, 0, 18, s.textHdr1, "#111827");
      this.drawTextBlock(g, state.sub1, usableW, 0, 40, s.textSub1, "#374151");
    }

    const sceneG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    sceneG.setAttribute("transform", `translate(0, ${sceneTop})`);
    g.appendChild(sceneG);

    const specs = (state.inputs.mode === 1 && state.inputs.buildings.length)
      ? state.inputs.buildings
      : this.expandGlobal(state);

    const n = Math.max(1, specs.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const cellW = usableW / cols;
    const cellH = sceneH / rows;

    for (let idx = 0; idx < n; idx++) {
      const rr = Math.floor(idx / cols);
      const cc = idx % cols;

      const ox = cc * cellW;
      const oy = rr * cellH;

      const cg = document.createElementNS("http://www.w3.org/2000/svg", "g");
      cg.setAttribute("transform", `translate(${ox}, ${oy})`);
      sceneG.appendChild(cg);

      const innerPad = 12;
      const w = Math.max(60, cellW - innerPad * 2);
      const h = Math.max(60, cellH - innerPad * 2);

      const cx = innerPad + w / 2;
      const groundY = innerPad + h * 0.74;

      // ------------------------------------------------------------
      // LANDSCAPING / GRASS / HEDGES
      // Commented out per your request (simplify for now).
      // ------------------------------------------------------------
      // if (s.showLandscaping) this.drawGrassOnly(cg, cx, groundY, w, h);

      const spec = specs[idx];
      if (s.renderMode === "isometric") {
        this.renderIsometricDatacenter(cg, cx, groundY, w, h, spec, s);
      } else {
        this.renderFootprintStack(cg, innerPad, innerPad, w, h, spec, s);
      }
    }

    // Footer
    this.drawFooter(g, usableW, usableH - footerH + 18, footerH, state, s);

    this.content.appendChild(svg);
  }

  private expandGlobal(state: RenderState): BuildingSpec[] {
    const count = clampInt(state.inputs.buildingCountGlobal || 1, 1, 20);
    const stories = clampInt(state.inputs.storiesGlobal || 1, 1, 20);
    const sqftPer = count > 0 ? (state.totalSqftAllBuildings / count) : 0;

    const arr: BuildingSpec[] = [];
    for (let i = 0; i < count; i++) arr.push({ sqft: Math.max(0, sqftPer), stories });
    return arr;
  }

  // ----------------------------
  // Landscaping (commented out for now)
  // ----------------------------
  /*
  private drawGrassOnly(g: SVGGElement, cx: number, groundY: number, w: number, h: number): void {
    const grass = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    grass.setAttribute("cx", `${cx}`);
    grass.setAttribute("cy", `${groundY + h * 0.02}`);
    grass.setAttribute("rx", `${w * 0.46}`);
    grass.setAttribute("ry", `${h * 0.18}`);
    grass.setAttribute("fill", "rgba(34, 197, 94, 0.22)");
    g.appendChild(grass);
  }
  */

  // ----------------------------
  // Renderers
  // ----------------------------
  private renderFootprintStack(
    g: SVGGElement,
    x0: number,
    y0: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: BuildingSettings
  ): void {
    const stories = Math.max(1, Math.round(spec.stories));
    const footprintArea = Math.max(1, spec.sqft / stories);

    const ar = 1.6;
    const fw = Math.sqrt(footprintArea * ar);
    const fd = footprintArea / fw;

    const scale = Math.min(w / fw, h / fd);

    const baseW = fw * scale;
    const baseD = fd * scale;

    const baseX = x0 + (w - baseW) / 2;
    const baseY = y0 + (h - baseD) / 2;

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
  }

  private renderIsometricDatacenter(
    g: SVGGElement,
    cx: number,
    groundY: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: BuildingSettings
  ): void {
    const stories = Math.max(1, Math.round(spec.stories));

    const FEET_PER_STORY = 10;

    const footprintArea = Math.max(1, spec.sqft / stories);
    const footprintSideFt = Math.sqrt(footprintArea);
    const heightFt = stories * FEET_PER_STORY;

    const maxW = w * 0.82;
    const maxH = h * 0.78;

    const scaleW = maxW / Math.max(1, 2 * footprintSideFt);
    const scaleH = maxH / Math.max(1, heightFt + footprintSideFt);

    const ftToPx = Math.min(scaleW, scaleH);

    const base = footprintSideFt * ftToPx;
    const heightPx = heightFt * ftToPx;

    // Center building (slight upward bias)
    const cx2 = cx;
    const cyTop = (groundY - heightPx) - base * 0.05;

    // Faces
    const top: Pt[] = [
      { x: cx2, y: cyTop - base },
      { x: cx2 + base, y: cyTop - base * 0.5 },
      { x: cx2, y: cyTop },
      { x: cx2 - base, y: cyTop - base * 0.5 }
    ];

    const front: Pt[] = [
      { x: cx2 - base, y: cyTop - base * 0.5 },
      { x: cx2, y: cyTop },
      { x: cx2, y: cyTop + heightPx },
      { x: cx2 - base, y: cyTop + heightPx - base * 0.5 }
    ];

    const side: Pt[] = [
      { x: cx2, y: cyTop },
      { x: cx2 + base, y: cyTop - base * 0.5 },
      { x: cx2 + base, y: cyTop + heightPx - base * 0.5 },
      { x: cx2, y: cyTop + heightPx }
    ];

    // Building
    this.poly(g, top, this.tint(s.fillColor, 0.25), s);
    this.poly(g, side, this.tint(s.fillColor, 0.45), s);
    this.poly(g, front, s.fillColor, s);

    // WINDOWS: 0.8 story band height (requested) + min pixel clamp
    this.drawIsometricWindows(g, front, stories, {
      mechEvery: Math.max(2, Math.round(s.mechEvery ?? 4)),
      windowDensity: Math.max(0.4, Math.min(2.0, s.windowDensity ?? 1.0)),
      skipGroundFloor: true,
      windowBandFraction: 0.8,
      minWindowPx: 2.5
    });

    // DOUBLE DOOR: side face, centered horizontally, only first-floor height
    this.drawDoubleDoorGroundFloor(g, side, stories);

    // ------------------------------------------------------------
    // HEDGES (commented out for now, per your request)
    // ------------------------------------------------------------
    // if (s.showLandscaping) {
    //   const storyPx = FEET_PER_STORY * ftToPx;
    //   const hedgeRadius = Math.max(3, storyPx * 0.4); // diameter = 0.8 story
    //   this.drawHedges4(g, top, heightPx, hedgeRadius);
    // }
  }

  private drawDoubleDoorGroundFloor(g: SVGGElement, side: Pt[], stories: number): void {
    const TL = side[0], TR = side[1], BR = side[2], BL = side[3];

    // vertical range for ground floor band
    const floors = Math.max(1, Math.round(stories));
    const v0 = 1 - (1 / floors);
    const v1 = 1.0;

    // centered on side face
    const u0 = 0.40;
    const u1 = 0.60;

    const door = quadPoly(TL, TR, BR, BL, u0, u1, v0, v1);
    door.setAttribute("fill", "rgba(17,24,39,0.10)");
    door.setAttribute("stroke", "rgba(17,24,39,0.18)");
    door.setAttribute("stroke-width", "0.8");
    g.appendChild(door);

    const um = (u0 + u1) / 2;
    const p1 = quadPoint(TL, TR, BR, BL, um, v0 + 0.08 * (v1 - v0));
    const p2 = quadPoint(TL, TR, BR, BL, um, v1 - 0.08 * (v1 - v0));

    const seam = document.createElementNS("http://www.w3.org/2000/svg", "line");
    seam.setAttribute("x1", `${p1.x}`);
    seam.setAttribute("y1", `${p1.y}`);
    seam.setAttribute("x2", `${p2.x}`);
    seam.setAttribute("y2", `${p2.y}`);
    seam.setAttribute("stroke", "rgba(17,24,39,0.25)");
    seam.setAttribute("stroke-width", "0.8");
    g.appendChild(seam);
  }

  private drawIsometricWindows(
    g: SVGGElement,
    front: Pt[],
    stories: number,
    opts: { mechEvery: number; windowDensity: number; skipGroundFloor: boolean; windowBandFraction: number; minWindowPx: number }
  ): void {
    const TL = front[0], TR = front[1], BR = front[2], BL = front[3];

    const floors = Math.max(1, stories);
    const band = 1 / floors;

    const baseCols = Math.max(4, Math.round(8 * opts.windowDensity));
    const marginU = 0.08;

    const faceHeightPx = Math.hypot(BR.y - TR.y, BR.x - TR.x);

    for (let f = 0; f < floors; f++) {
      const floorFromBottom = floors - f;
      const v0 = f * band;
      const v1 = (f + 1) * band;

      if (opts.skipGroundFloor && floorFromBottom === 1) continue;

      const isMech = (floorFromBottom % opts.mechEvery === 0);
      const cols = isMech ? Math.max(2, Math.floor(baseCols * 0.55)) : baseCols;

      if (isMech) {
        const strip = quadPoly(TL, TR, BR, BL, 0.0, 1.0, v0, v1);
        strip.setAttribute("fill", "rgba(17,24,39,0.10)");
        strip.setAttribute("stroke", "none");
        g.appendChild(strip);
      }

      const desiredBandFrac = Math.max(0.4, Math.min(0.92, opts.windowBandFraction));
      const desiredWindowHeightPx = (v1 - v0) * faceHeightPx * desiredBandFrac;

      const windowHeightPx = Math.max(opts.minWindowPx, desiredWindowHeightPx);
      const effectiveFrac = Math.min(0.92, windowHeightPx / ((v1 - v0) * faceHeightPx));

      const centerV = (v0 + v1) / 2;
      const winV0 = centerV - (band * effectiveFrac) / 2;
      const winV1 = centerV + (band * effectiveFrac) / 2;

      const windowW = (1 - marginU * 2) / cols * 0.55;
      const gapW = (1 - marginU * 2) / cols * 0.45;

      for (let c = 0; c < cols; c++) {
        const u0 = marginU + c * (windowW + gapW);
        const u1 = u0 + windowW;

        const jitter = hash01(f + 1, c + 1);
        const alpha = isMech ? 0.22 : 0.30;
        const brighten = lerpNumber(0.0, 0.12, jitter);
        const fill = rgbaTint("#E6F2FF", alpha, brighten);

        const win = quadPoly(TL, TR, BR, BL, u0, u1, winV0, winV1);
        win.setAttribute("fill", fill);
        win.setAttribute("stroke", "rgba(17,24,39,0.08)");
        win.setAttribute("stroke-width", "0.6");
        g.appendChild(win);
      }
    }
  }

  /*
  private drawHedges4(g: SVGGElement, top: Pt[], heightPx: number, r: number): void {
    const ground: Pt[] = top.map(p => ({ x: p.x, y: p.y + heightPx }));
    const FL = ground[3];
    const FR = ground[2];
    const BL = ground[0];
    const BR = ground[1];

    const t = 0.20;
    const h1 = lerpPt(FL, FR, t);
    const h2 = lerpPt(FL, BL, t);
    const h3 = lerpPt(FR, FL, t);
    const h4 = lerpPt(FR, BR, t);

    const pts = [h1, h2, h3, h4];
    for (const p of pts) {
      const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      c.setAttribute("cx", `${p.x}`);
      c.setAttribute("cy", `${p.y}`);
      c.setAttribute("r", `${r}`);
      c.setAttribute("fill", "rgba(34, 197, 94, 1.0)");
      g.appendChild(c);
    }
  }
  */

  private drawFooter(g: SVGGElement, width: number, yTop: number, footerH: number, state: RenderState, s: BuildingSettings): void {
    const RED = "#DC2626";

    const hdr2 = `Estimated Total Trucks (Project Duration): ${fmt(state.totalTrucks)}`;
    const body1 = `Buildings: ${fmt(state.buildingTrucks)} trucks • Site Infrastructure: ${fmt(state.infraTrucks)} trucks`;

    const body2 = (state.avgTrucksPerReceivingDay !== undefined)
      ? `Avg Trucks per Receiving Day: ${fmt(Math.ceil(state.avgTrucksPerReceivingDay))}`
      : `Avg Trucks per Receiving Day: N/A`;

    const tphText = (state.trucksPerHourPerGate !== undefined)
      ? `Trucks per Hour per Gate: ${state.trucksPerHourPerGate.toFixed(1)}`
      : `Trucks per Hour per Gate: N/A`;

    const fteText = (state.securityStaffMin !== undefined && state.securityStaffMax !== undefined)
      ? `Suggested Gate Security Staff: ${fmt(state.securityStaffMin)}–${fmt(state.securityStaffMax)}`
      : `Suggested Gate Security Staff: N/A`;

    const cap = state.throughputThreshold ?? (state.inputs.stagingArea ? 30 : 6);
    const warnText = `Gate throughput exceeds estimated capacity of ${cap} trucks per hour.`;

    const showWarn = !!state.isThroughputHigh;

    // Build a list of lines so we can guarantee FTE stays visible
    const lines: Array<{ text: string; style: any; color: string }> = [];

    // Slightly smaller header than before (less unwieldy)
    const hdr2Size = Math.max(12, Math.min(s.textHdr2.size, Math.round(footerH * 0.13)));
    const bodySize = Math.max(10, Math.min(s.textBody.size, Math.round(footerH * 0.11)));
    const warnSize = Math.max(9, Math.min(s.textWarn.size, Math.round(footerH * 0.095)));

    lines.push({ text: hdr2, style: { ...s.textHdr2, size: hdr2Size }, color: "#111827" });
    lines.push({ text: body1, style: { ...s.textBody, size: bodySize }, color: "#374151" });
    lines.push({ text: body2, style: { ...s.textBody, size: bodySize }, color: "#374151" });

    const tphColor = showWarn ? RED : "#374151";
    lines.push({ text: tphText, style: { ...s.textBody, size: bodySize }, color: tphColor });

    if (showWarn) {
      lines.push({ text: warnText, style: { ...s.textWarn, size: warnSize }, color: RED });
    }

    // Always last so it never "falls off"
    lines.push({ text: fteText, style: { ...s.textBody, size: bodySize }, color: "#111827" });

    // Height-aware layout so nothing disappears
    const maxY = yTop + footerH - 8;
    const lineHeights = lines.map(l => Math.max(14, Math.round(l.style.size * 1.25)));
    let totalTextH = lineHeights.reduce((a, b) => a + b, 0);

    // Base gap, then compress if needed
    let gap = 10;
    const remaining = (maxY - yTop) - totalTextH;
    if (remaining > 0) {
      gap = Math.max(8, Math.floor(remaining / (lines.length + 1)));
    } else {
      // If it doesn't fit, reduce gap and shrink a touch
      gap = 6;
    }

    let y = yTop + gap;

    for (let i = 0; i < lines.length; i++) {
      const lh = lineHeights[i];
      // If we’re about to overflow, nudge upward / compress spacing slightly
      if (y + lh > maxY) {
        y = Math.max(yTop + 4, maxY - lh);
      }
      this.drawTextBlock(g, lines[i].text, width, 0, y, lines[i].style, lines[i].color);
      y += lh + gap;
    }
  }

  // ----------------------------
  // Text drawing with alignment + wrap
  // ----------------------------
  private drawTextBlock(
    g: SVGGElement,
    text: string,
    maxWidth: number,
    xPad: number,
    y: number,
    style: { size: number; bold: boolean; italic: boolean; underline: boolean; align: "left" | "center" | "right"; wrap: boolean },
    color: string
  ): void {
    const x =
      style.align === "left" ? xPad :
        style.align === "right" ? (maxWidth - xPad) :
          (maxWidth / 2);

    const anchor =
      style.align === "left" ? "start" :
        style.align === "right" ? "end" :
          "middle";

    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", `${x}`);
    t.setAttribute("y", `${y}`);
    t.setAttribute("text-anchor", anchor);
    t.setAttribute("fill", color);
    t.setAttribute("font-family", "Segoe UI, sans-serif");
    t.setAttribute("font-size", `${style.size}`);
    t.setAttribute("font-weight", style.bold ? "700" : "400");
    t.setAttribute("font-style", style.italic ? "italic" : "normal");
    t.setAttribute("text-decoration", style.underline ? "underline" : "none");

    if (!style.wrap) {
      t.textContent = text;
      g.appendChild(t);
      return;
    }

    // Simple word-wrap into tspans using approximate character width.
    const approxCharW = style.size * 0.58;
    const usable = Math.max(40, maxWidth - xPad * 2);
    const maxChars = Math.max(10, Math.floor(usable / approxCharW));

    const words = text.split(/\s+/);
    const lines: string[] = [];

    let cur = "";
    for (const w of words) {
      const candidate = cur ? `${cur} ${w}` : w;
      if (candidate.length <= maxChars) {
        cur = candidate;
      } else {
        if (cur) lines.push(cur);
        cur = w;
      }
    }
    if (cur) lines.push(cur);

    const lineH = Math.max(12, Math.round(style.size * 1.15));
    for (let i = 0; i < lines.length; i++) {
      const sp = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
      sp.setAttribute("x", `${x}`);
      sp.setAttribute("dy", i === 0 ? "0" : `${lineH}`);
      sp.textContent = lines[i];
      t.appendChild(sp);
    }
    g.appendChild(t);
  }

  // ----------------------------
  // SVG helpers
  // ----------------------------
  private poly(g: SVGGElement, pts: Pt[], fill: string, s: BuildingSettings): void {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    p.setAttribute("points", pts.map(d => `${d.x},${d.y}`).join(" "));
    p.setAttribute("fill", fill);
    p.setAttribute("stroke", s.outlineColor);
    p.setAttribute("stroke-width", `${Math.max(1, s.outlineWidth * 0.7)}`);
    p.setAttribute("stroke-linejoin", "round");
    g.appendChild(p);
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

  private async exportSnapshot(): Promise<void> {
    try {
      if (!this.lastSvg) return;
      const status = await this.downloadService.exportStatus();
      if (status !== powerbi.PrivilegeStatus.Allowed) return;

      const serializer = new XMLSerializer();
      const svgXml = serializer.serializeToString(this.lastSvg);

      await this.downloadService.exportVisualsContent(
        svgXml,
        "DataCenterMockup.xml",
        "xml",
        "Data center mockup (SVG as XML)"
      );
    } catch {
      // ignore
    }
  }

  private tint(hex: string, t: number): string {
    const c = hex.replace("#", "");
    const r = parseInt(c.substring(0, 2), 16);
    const gg = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);

    const mix = (v: number) => Math.round(v + (255 - v) * Math.min(0.6, t * 0.6));
    return `rgb(${mix(r)}, ${mix(gg)}, ${mix(b)})`;
  }
}

// ----------------------------
// Geometry + math helpers
// ----------------------------
function quadPoint(TL: Pt, TR: Pt, BR: Pt, BL: Pt, u: number, v: number): Pt {
  const x =
    TL.x * (1 - u) * (1 - v) +
    TR.x * u * (1 - v) +
    BR.x * u * v +
    BL.x * (1 - u) * v;

  const y =
    TL.y * (1 - u) * (1 - v) +
    TR.y * u * (1 - v) +
    BR.y * u * v +
    BL.y * (1 - u) * v;

  return { x, y };
}

function quadPoly(TL: Pt, TR: Pt, BR: Pt, BL: Pt, u0: number, u1: number, v0: number, v1: number): SVGPolygonElement {
  const p1 = quadPoint(TL, TR, BR, BL, u0, v0);
  const p2 = quadPoint(TL, TR, BR, BL, u1, v0);
  const p3 = quadPoint(TL, TR, BR, BL, u1, v1);
  const p4 = quadPoint(TL, TR, BR, BL, u0, v1);

  const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  poly.setAttribute("points", `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y} ${p4.x},${p4.y}`);
  return poly;
}

function clampInt(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, Math.round(x)));
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function hash01(a: number, b: number): number {
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function rgbaTint(hex: string, alpha: number, brighten: number): string {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);

  const rr = Math.min(255, Math.round(r + (255 - r) * brighten));
  const gg = Math.min(255, Math.round(g + (255 - g) * brighten));
  const bb = Math.min(255, Math.round(b + (255 - b) * brighten));

  return `rgba(${rr},${gg},${bb},${alpha})`;
}