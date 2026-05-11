"use strict";

import powerbi from "powerbi-visuals-api";
import IVisual = powerbi.extensibility.visual.IVisual;
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IDownloadService = powerbi.extensibility.IDownloadService;

import { getSettings } from "./settings";

type BuildingSpec = { sqft: number; stories: number };

type Inputs = {
  mode: number;                 // 0=Global, 1=Individual
  acreage: number;

  // Global mode controls
  totalSqft: number;            // total sqft across all buildings
  storiesGlobal: number;        // stories per building
  buildingCountGlobal: number;  // number of buildings

  // Individual mode controls (up to 10)
  buildings: BuildingSpec[];    // derived from B1..B10 params

  // Optional logistics controls (do not affect rendering)
  hoursPerDay: number;          // receiving hours/day
  daysPerWeek: number;          // receiving days/week
  gates: number;                // receiving gates
  projectMonths: number;        // duration in months (exec friendly)

  // NEW optional input: staging area (Y/N coded as 1/0)
  stagingArea: boolean;         // true => Y, false => N
};

type RenderState = {
  inputs: Inputs;
  headline: string;
  subline: string;

  totalBuildings: number;
  totalSqftAllBuildings: number;

  totalTrucks: number;
  buildingTrucks: number;
  infraTrucks: number;

  avgTrucksPerReceivingDay?: number;
  trucksPerHourPerGate?: number;

  // NEW: throughput threshold + flag
  throughputThreshold?: number;
  isThroughputHigh?: boolean;

  securityStaffMin?: number;
  securityStaffMax?: number;
};

type Pt = { x: number; y: number };

export class Visual implements IVisual {
  private root: HTMLElement;
  private content: HTMLDivElement;
  private lastSvg?: SVGSVGElement;

  private downloadService: IDownloadService;

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

    // Export button (still available)
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
    const measureMap = this.buildMeasureMap(values);
    const inputs = this.parseInputs(measureMap);
    const state = this.computeScenario(inputs);

    this.render(viewport, s, state);
  }

  // ----------------------------
  // Input Parsing
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
          for (const [name, val] of measures) {
            if (k.test(name)) return val;
          }
        }
      }
      return fallback;
    };

    const mode = clampInt(get([/^mode$/i, /^scenario\s*mode$/i, /^input\s*mode$/i], 0), 0, 1);
    const acreage = Math.max(0, get([/^acreage$/i, /^site\s*acreage$/i], 0));

    // Global controls
    const totalSqft = Math.max(0, get([/^total\s*sqft$/i, /^total\s*square\s*foot(age)?$/i, /^square\s*foot(age)?$/i], 0));
    const storiesGlobal = Math.max(0, get([/^stories$/i, /^stories\s*per\s*building$/i], 0));
    const buildingCountGlobal = Math.max(0, get([/^building\s*count$/i, /^buildings$/i, /^number\s*of\s*buildings$/i], 0));

    // Optional logistics controls
    const hoursPerDay = Math.max(0, get([/^hours\s*per\s*day$/i, /^receiving\s*hours\s*per\s*day$/i], 0));
    const daysPerWeek = Math.max(0, get([/^days\s*per\s*week$/i, /^receiving\s*days\s*per\s*week$/i], 0));
    const gates = Math.max(0, get([/^receiving\s*gates$/i, /^gates$/i, /^number\s*of\s*gates$/i], 0));

    // Project duration: preferred input is months
    // Fallback: accept weeks and convert to months to avoid breaking older reports.
    const weeksPerMonth = 4.345;
    const projectMonthsDirect = Math.max(0, get([/^project\s*months$/i, /^duration\s*\(months\)$/i], 0));
    const projectWeeksFallback = Math.max(0, get([/^project\s*weeks$/i, /^duration\s*\(weeks\)$/i], 0));
    const projectMonths = projectMonthsDirect > 0 ? projectMonthsDirect : (projectWeeksFallback > 0 ? (projectWeeksFallback / weeksPerMonth) : 0);

    // NEW: staging area Y/N coded as 1/0 (or any value >= 0.5 means Yes)
    const stagingAreaVal = get(
      [/^staging\s*area$/i, /^has\s*staging\s*area$/i, /^staging\s*area\s*\(y\/n\)$/i],
      0
    );
    const stagingArea = stagingAreaVal >= 0.5;

    // Individual controls: up to 10 buildings (default 0 => ignored)
    const perSqft: number[] = new Array(10).fill(0);
    const perStories: number[] = new Array(10).fill(0);

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
      const sqft = perSqft[i];
      const stories = perStories[i];
      if (sqft > 0 && stories > 0) buildings.push({ sqft, stories });
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

    // e.g. "B1 SqFt", "B10 Stories"
    let m = n.match(/^b(?:uilding)?\s*0*([1-9]|10)\s*(sqft|square\s*foot(age)?|stories)$/i);
    if (m) {
      const index = parseInt(m[1], 10);
      const tail = m[2].toLowerCase();
      return { index, kind: tail.startsWith("stor") ? "stories" : "sqft" };
    }

    // e.g. "Building 3 SqFt"
    m = n.match(/^building\s*0*([1-9]|10)\s*(sqft|square\s*foot(age)?|stories)$/i);
    if (m) {
      const index = parseInt(m[1], 10);
      const tail = m[2].toLowerCase();
      return { index, kind: tail.startsWith("stor") ? "stories" : "sqft" };
    }

    // e.g. "SqFt_Bldg_3" or "Stories_Bldg_7"
    m = n.match(/^(sqft|stories)\s*[_-]?\s*(bldg|building)\s*[_-]?\s*0*([1-9]|10)$/i);
    if (m) {
      const kind = m[1].toLowerCase() === "stories" ? "stories" : "sqft";
      const index = parseInt(m[3], 10);
      return { index, kind };
    }

    return null;
  }

  // ----------------------------
  // Scenario + Truck math
  // ----------------------------

  private computeScenario(inputs: Inputs): RenderState {
    const MIN_STORIES = 1;
    const MAX_STORIES = 20;
    const MIN_FLOOR_AREA = 100;

    const TRUCKS_PER_SQFT = 0.044;
    const TRUCKS_PER_ACRE = 18;

    // NEW thresholds based on staging area
    const THRESHOLD_WITH_STAGING = 30; // trucks per hour per gate
    const THRESHOLD_NO_STAGING = 6;    // trucks per hour per gate

    let buildings: BuildingSpec[] = [];
    let totalSqftAllBuildings = 0;

    if (inputs.mode === 1) {
      buildings = inputs.buildings.map(b => ({
        sqft: b.sqft,
        stories: clampInt(b.stories, MIN_STORIES, MAX_STORIES)
      }));

      buildings = buildings.map(b => {
        const maxStoriesByFloor = Math.max(MIN_STORIES, Math.floor(b.sqft / MIN_FLOOR_AREA));
        const stories = Math.min(b.stories, maxStoriesByFloor, MAX_STORIES);
        return { sqft: b.sqft, stories };
      });

      totalSqftAllBuildings = buildings.reduce((acc, b) => acc + b.sqft, 0);
    } else {
      const bCount = clampInt(inputs.buildingCountGlobal || 1, 1, 20);
      const stories = clampInt(inputs.storiesGlobal || 1, MIN_STORIES, MAX_STORIES);

      const sqftPerBuilding = bCount > 0 ? (inputs.totalSqft / bCount) : 0;

      buildings = new Array(bCount).fill(0).map(() => ({
        sqft: Math.max(0, sqftPerBuilding),
        stories
      }));

      buildings = buildings.map(b => {
        const maxStoriesByFloor = Math.max(MIN_STORIES, Math.floor(b.sqft / MIN_FLOOR_AREA));
        const s = Math.min(b.stories, maxStoriesByFloor, MAX_STORIES);
        return { sqft: b.sqft, stories: s };
      });

      totalSqftAllBuildings = inputs.totalSqft;
    }

    const totalBuildings = buildings.length;

    const headline =
      inputs.mode === 1
        ? `Individual Mode • Buildings Configured: ${totalBuildings}`
        : `Global Mode • ${totalBuildings} Buildings`;

    const subline =
      `Total SqFt: ${fmt(Math.round(totalSqftAllBuildings))} • Site: ${fmt(Math.round(inputs.acreage))} acres`;

    // Trucks
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

    // NEW threshold + flag
    const throughputThreshold = inputs.stagingArea ? THRESHOLD_WITH_STAGING : THRESHOLD_NO_STAGING;
    const isThroughputHigh =
      (trucksPerHourPerGate !== undefined) ? (trucksPerHourPerGate > throughputThreshold) : false;

    // Staffing assumptions (well-commented for easy tuning)
    const STAFF_PER_GATE_AT_ALL_TIMES = 2;
    const MIN_HOURS_PER_STAFF_PER_WEEK = 30;
    const MAX_HOURS_PER_STAFF_PER_WEEK = 50;

    const weeklyCoverageHours =
      (inputs.hoursPerDay > 0 && inputs.daysPerWeek > 0) ? (inputs.hoursPerDay * inputs.daysPerWeek) : 0;

    let securityStaffMin: number | undefined;
    let securityStaffMax: number | undefined;

    if (inputs.gates > 0 && weeklyCoverageHours > 0) {
      const requiredStaffHoursPerWeek = inputs.gates * STAFF_PER_GATE_AT_ALL_TIMES * weeklyCoverageHours;
      securityStaffMin = Math.ceil(requiredStaffHoursPerWeek / MAX_HOURS_PER_STAFF_PER_WEEK);
      securityStaffMax = Math.ceil(requiredStaffHoursPerWeek / MIN_HOURS_PER_STAFF_PER_WEEK);
    }

    return {
      inputs,
      headline,
      subline,
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
  // Rendering (unchanged from your current version)
  // ----------------------------

  private render(viewport: powerbi.IViewport, s: any, state: RenderState): void {
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

    if (s.showLabels) {
      this.drawText(g, state.headline, usableW / 2, 18, { size: 14, weight: "700", color: "#111827" });
      this.drawText(g, state.subline, usableW / 2, 40, { size: 11, weight: "400", color: "#374151" });
    }

    const sceneG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    sceneG.setAttribute("transform", `translate(0, ${sceneTop})`);
    g.appendChild(sceneG);

    const specs: BuildingSpec[] =
      state.inputs.mode === 1 ? (state.inputs.buildings.length ? state.inputs.buildings : [{ sqft: 0, stories: 0 }])
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
      const groundY = innerPad + h * 0.72;

      const spec = specs[idx];

      if (s.showLandscaping) this.drawGrassPlane(cg, cx, groundY, w, h);

      if (s.renderMode === "isometric") {
        this.renderIsometricDatacenter(cg, cx, groundY, w, h, spec, s);
      } else {
        this.renderFootprintStack(cg, innerPad, innerPad, w, h, spec, s);
      }

      if (s.showLandscaping) this.drawHedges(cg, cx, groundY, w, h);
    }

    this.drawFooter(g, usableW, usableH - footerH + 20, footerH, state);

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
  // Landscaping (existing)
  // ----------------------------

  private drawGrassPlane(g: SVGGElement, cx: number, groundY: number, w: number, h: number): void {
    const grass = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    grass.setAttribute("cx", `${cx}`);
    grass.setAttribute("cy", `${groundY + h * 0.02}`);
    grass.setAttribute("rx", `${w * 0.46}`);
    grass.setAttribute("ry", `${h * 0.18}`);
    grass.setAttribute("fill", "rgba(34, 197, 94, 0.22)");
    g.appendChild(grass);

    const road = document.createElementNS("http://www.w3.org/2000/svg", "path");
    road.setAttribute("d", `M ${cx - w * 0.30} ${groundY + h * 0.06} Q ${cx} ${groundY + h * 0.11} ${cx + w * 0.30} ${groundY + h * 0.06}`);
    road.setAttribute("fill", "none");
    road.setAttribute("stroke", "rgba(107,114,128,0.25)");
    road.setAttribute("stroke-width", "3");
    road.setAttribute("stroke-linecap", "round");
    g.appendChild(road);
  }

  private drawHedges(g: SVGGElement, cx: number, groundY: number, w: number, h: number): void {
    const r = Math.max(7, Math.min(w, h) * 0.045);
    const positions: Array<[number, number]> = [
      [cx - w * 0.16, groundY - h * 0.03],
      [cx,            groundY - h * 0.02],
      [cx + w * 0.16, groundY - h * 0.03]
    ];

    for (const [x, y] of positions) {
      const blob = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      blob.setAttribute("cx", `${x}`);
      blob.setAttribute("cy", `${y}`);
      blob.setAttribute("r", `${r}`);
      blob.setAttribute("fill", "rgba(34, 197, 94, 0.92)");
      g.appendChild(blob);
    }
  }

  // ----------------------------
  // Renderers (existing)
  // ----------------------------

  private renderFootprintStack(
    g: SVGGElement,
    x0: number,
    y0: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: any
  ): void {
    const footprintZoneH = h * 0.55;
    const heightZoneH = h * 0.45;

    const stories = Math.max(1, Math.round(spec.stories));
    const footprintArea = Math.max(1, spec.sqft / stories);

    const ar = 1.6;
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
  }

  private renderIsometricDatacenter(
    g: SVGGElement,
    cx: number,
    groundY: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: any
  ): void {
    const stories = Math.max(1, Math.round(spec.stories));
    const FEET_PER_STORY = 10;

    const footprintArea = Math.max(1, spec.sqft / stories);
    const footprintSideFt = Math.sqrt(footprintArea);
    const heightFt = stories * FEET_PER_STORY;

    const maxW = w * 0.80;
    const maxH = h * 0.78;

    const scaleW = maxW / Math.max(1, 2 * footprintSideFt);
    const scaleH = maxH / Math.max(1, heightFt + footprintSideFt);

    const ftToPx = Math.min(scaleW, scaleH);

    const base = footprintSideFt * ftToPx;
    const heightPx = heightFt * ftToPx;

    const cy = groundY - heightPx;

    const shadow = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    shadow.setAttribute("cx", `${cx}`);
    shadow.setAttribute("cy", `${groundY + base * 0.35}`);
    shadow.setAttribute("rx", `${base * 1.10}`);
    shadow.setAttribute("ry", `${base * 0.46}`);
    shadow.setAttribute("fill", "rgba(0,0,0,0.10)");
    g.appendChild(shadow);

    const top: Pt[] = [
      { x: cx, y: cy - base },
      { x: cx + base, y: cy - base * 0.5 },
      { x: cx, y: cy },
      { x: cx - base, y: cy - base * 0.5 }
    ];

    const front: Pt[] = [
      { x: cx - base, y: cy - base * 0.5 },
      { x: cx, y: cy },
      { x: cx, y: cy + heightPx },
      { x: cx - base, y: cy + heightPx - base * 0.5 }
    ];

    const side: Pt[] = [
      { x: cx, y: cy },
      { x: cx + base, y: cy - base * 0.5 },
      { x: cx + base, y: cy + heightPx - base * 0.5 },
      { x: cx, y: cy + heightPx }
    ];

    this.poly(g, top, this.tint(s.fillColor, 0.25), s);
    this.poly(g, side, this.tint(s.fillColor, 0.45), s);
    this.poly(g, front, s.fillColor, s);
  }

  // ----------------------------
  // Footer (updated for throughput warning + red styling)
  // ----------------------------

  private drawFooter(g: SVGGElement, width: number, yTop: number, footerH: number, state: RenderState): void {
    const RED = "#DC2626";

    const titleSize = Math.max(18, Math.round(footerH * 0.18));
    const lineSize = Math.max(13, Math.round(footerH * 0.12));
    const lineGap = Math.max(22, Math.round(footerH * 0.18));

    const title = `Estimated Total Trucks (Project Duration): ${fmt(state.totalTrucks)}`;
    this.drawText(g, title, width / 2, yTop, { size: titleSize, weight: "800", color: "#111827" });

    const line1 = `Buildings: ${fmt(state.buildingTrucks)} trucks  •  Site Infrastructure: ${fmt(state.infraTrucks)} trucks`;
    this.drawText(g, line1, width / 2, yTop + lineGap, { size: lineSize, weight: "400", color: "#374151" });

    const line2 = (state.avgTrucksPerReceivingDay !== undefined)
      ? `Avg Trucks per Receiving Day: ${fmt(Math.ceil(state.avgTrucksPerReceivingDay))}`
      : `Avg Trucks per Receiving Day: N/A`;
    this.drawText(g, line2, width / 2, yTop + lineGap * 2, { size: lineSize, weight: "400", color: "#374151" });

    // NEW: staging area label and threshold
    const stagingLabel = state.inputs.stagingArea ? "Y" : "N";
    const threshold = state.throughputThreshold ?? (state.inputs.stagingArea ? 30 : 6);

    // Trucks per hour per gate line: number turns red if above threshold
    const line3Text = (state.trucksPerHourPerGate !== undefined)
      ? `Trucks per Hour per Gate: ${state.trucksPerHourPerGate.toFixed(1)}`
      : `Trucks per Hour per Gate: N/A`;

    const line3Color =
      (state.isThroughputHigh && state.trucksPerHourPerGate !== undefined) ? RED : "#374151";

    this.drawText(g, line3Text, width / 2, yTop + lineGap * 3, { size: lineSize, weight: "400", color: line3Color });

    // Optional staging/threshold informational line (neutral)
    const line3b = `Staging Area: ${stagingLabel}  •  Threshold: ${fmt(threshold)} trucks per hour per gate`;
    this.drawText(g, line3b, width / 2, yTop + lineGap * 4, { size: lineSize, weight: "400", color: "#374151" });

    // Warning line in red if high throughput
    if (state.isThroughputHigh) {
      const warn = "High gate throughput. Consider adding gates or increasing hours of operation.";
      this.drawText(g, warn, width / 2, yTop + lineGap * 5, { size: lineSize, weight: "700", color: RED });
    }

    const line5Y = state.isThroughputHigh ? (yTop + lineGap * 6) : (yTop + lineGap * 5);

    const line5 = (state.securityStaffMin !== undefined && state.securityStaffMax !== undefined)
      ? `Suggested Gate Security Staff: ${fmt(state.securityStaffMin)}–${fmt(state.securityStaffMax)}`
      : `Suggested Gate Security Staff: N/A`;
    this.drawText(g, line5, width / 2, line5Y, { size: lineSize, weight: "400", color: "#111827" });
  }

  // ----------------------------
  // SVG helpers
  // ----------------------------

  private poly(g: SVGGElement, pts: Pt[], fill: string, s: any): void {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    p.setAttribute("points", pts.map(d => `${d.x},${d.y}`).join(" "));
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
      await this.downloadService.exportVisualsContent(svgXml, "DataCenterMockup.xml", "xml", "Data center mockup (SVG as XML)");
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
// Math helpers
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