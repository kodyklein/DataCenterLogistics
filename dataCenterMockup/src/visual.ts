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

  // Optional logistics controls
  hoursPerDay: number;          // receiving hours/day
  daysPerWeek: number;          // receiving days/week
  gates: number;                // receiving gates
  projectWeeks: number;         // duration in weeks (needed to compute trucks/day)
};

type RenderState = {
  inputs: Inputs;
  headline: string;
  subline: string;

  // Totals used for footer
  totalBuildings: number;
  totalSqftAllBuildings: number;
  totalTrucks: number;
  buildingTrucks: number;
  infraTrucks: number;

  avgTrucksPerReceivingDay?: number;     // if projectWeeks + days/week supplied
  trucksPerHourPerGate?: number;         // if hours/day + gates supplied
  securityStaffMin?: number;             // based on 50 hrs/week max per staff
  securityStaffMax?: number;             // based on 30 hrs/week min per staff
};

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
      this.renderMessage("Drop your input measures into the visual (Total SqFt, Stories, Building Count, Acreage, etc.).");
      return;
    }

    const s = getSettings(dataView);

    // Parse measures by display name (since we use one generic “Inputs” bucket)
    const measureMap = this.buildMeasureMap(values);

    const inputs = this.parseInputs(measureMap);

    // Compute scenario (global vs individual)
    const scenario = this.computeScenario(inputs);

    // Render
    this.render(viewport, s, scenario);
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
    // Helper to pull by name with flexible matching (execs will use slicers, but authors name measures)
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

    // Mode: 0=Global, 1=Individual
    const mode = clampInt(get([/^mode$/i, /^scenario\s*mode$/i, /^input\s*mode$/i], 0), 0, 1);

    const acreage = Math.max(0, get([/^acreage$/i, /^site\s*acreage$/i], 0));

    // Global controls
    const totalSqft = Math.max(0, get([/^total\s*sqft$/i, /^total\s*square\s*foot(age)?$/i, /^square\s*foot(age)?$/i], 0));
    const storiesGlobal = Math.max(0, get([/^stories$/i, /^stories\s*per\s*building$/i], 0));
    const buildingCountGlobal = Math.max(0, get([/^building\s*count$/i, /^buildings$/i, /^number\s*of\s*buildings$/i], 0));

    // Optional logistics controls (do not affect rendering)
    const hoursPerDay = Math.max(0, get([/^hours\s*per\s*day$/i, /^receiving\s*hours\s*per\s*day$/i], 0));
    const daysPerWeek = Math.max(0, get([/^days\s*per\s*week$/i, /^receiving\s*days\s*per\s*week$/i], 0));
    const gates = Math.max(0, get([/^receiving\s*gates$/i, /^gates$/i, /^number\s*of\s*gates$/i], 0));

    // Needed to compute trucks/day meaningfully
    const projectWeeks = Math.max(0, get([/^project\s*weeks$/i, /^duration\s*\(weeks\)$/i], 0));

    // Individual controls: up to 10 buildings
    const perSqft: number[] = new Array(10).fill(0);
    const perStories: number[] = new Array(10).fill(0);

    for (const [name, val] of measures) {
      // Match patterns like "B1 SqFt", "B10 Stories", "Building 2 SqFt", "SqFt_Bldg_3", etc.
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
      // Default to 0 = ignored. Only include complete buildings.
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
      projectWeeks
    };
  }

  private matchBuildingParam(name: string): { index: number; kind: "sqft" | "stories" } | null {
    const n = name.trim();

    // Building index patterns
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

  private computeScenario(inputs: Inputs): RenderState {
    const MIN_STORIES = 1;
    const MAX_STORIES = 20;
    const MIN_FLOOR_AREA = 100; // sq ft per floor (per building)

    let buildings: BuildingSpec[] = [];
    let totalSqftAllBuildings = 0;

    if (inputs.mode === 1) {
      // Individual mode: use per-building list
      buildings = inputs.buildings.map(b => ({
        sqft: b.sqft,
        stories: clampInt(b.stories, MIN_STORIES, MAX_STORIES)
      }));

      // Enforce min floor area per building by reducing stories if needed
      buildings = buildings.map(b => {
        const maxStoriesByFloor = Math.max(MIN_STORIES, Math.floor(b.sqft / MIN_FLOOR_AREA));
        const stories = Math.min(b.stories, maxStoriesByFloor, MAX_STORIES);
        return { sqft: b.sqft, stories };
      });

      totalSqftAllBuildings = buildings.reduce((acc, b) => acc + b.sqft, 0);
    } else {
      // Global mode: totalSqft is total across all buildings
      const bCount = clampInt(inputs.buildingCountGlobal || 1, 1, 20);
      const stories = clampInt(inputs.storiesGlobal || 1, MIN_STORIES, MAX_STORIES);

      // Per-building sqft derived from total
      const sqftPerBuilding = bCount > 0 ? (inputs.totalSqft / bCount) : 0;

      buildings = new Array(bCount).fill(0).map(() => ({
        sqft: Math.max(0, sqftPerBuilding),
        stories
      }));

      // Enforce min floor area per building
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

    // ----------------------------
    // Truck math (your requirements)
    // ----------------------------
    // Trucks for buildings: totalSqFtAllBuildings * 0.04, round up
    const buildingTrucks = Math.ceil(totalSqftAllBuildings * 0.04);

    // Trucks for infrastructure: acreage * 18, round up
    const infraTrucks = Math.ceil(inputs.acreage * 18);

    const totalTrucks = buildingTrucks + infraTrucks;

    // ----------------------------
    // Throughput + staffing (optional inputs)
    // ----------------------------
    let avgTrucksPerReceivingDay: number | undefined;
    let trucksPerHourPerGate: number | undefined;

    // We need projectWeeks to define how many receiving days exist.
    // If projectWeeks is missing/0, we can't compute meaningful per-day throughput.
    if (inputs.projectWeeks > 0 && inputs.daysPerWeek > 0) {
      const receivingDays = inputs.projectWeeks * inputs.daysPerWeek;
      if (receivingDays > 0) {
        avgTrucksPerReceivingDay = totalTrucks / receivingDays;
      }
    }

    if (avgTrucksPerReceivingDay !== undefined && inputs.hoursPerDay > 0 && inputs.gates > 0) {
      trucksPerHourPerGate = avgTrucksPerReceivingDay / (inputs.hoursPerDay * inputs.gates);
    }

    // ----------------------------
    // Security staffing assumptions
    // ----------------------------
    // Commented heavily per your request:
    //
    // - We assume 2 people per gate at all times (during receiving operations).
    // - We assume each staff member can work between:
    //      MIN_HOURS_PER_STAFF and MAX_HOURS_PER_STAFF per week.
    // - We compute a *range* of staff needed based on those bounds.
    //
    const STAFF_PER_GATE_AT_ALL_TIMES = 2;

    // Interpret "receiving at all times" as "during receiving hours"
    // Weekly receiving coverage hours:
    const weeklyCoverageHours = inputs.hoursPerDay > 0 && inputs.daysPerWeek > 0
      ? inputs.hoursPerDay * inputs.daysPerWeek
      : 0;

    // Tweak these if leadership changes your assumptions:
    const MIN_HOURS_PER_STAFF_PER_WEEK = 30;
    const MAX_HOURS_PER_STAFF_PER_WEEK = 50;

    let securityStaffMin: number | undefined;
    let securityStaffMax: number | undefined;

    if (inputs.gates > 0 && weeklyCoverageHours > 0) {
      const requiredStaffHoursPerWeek = inputs.gates * STAFF_PER_GATE_AT_ALL_TIMES * weeklyCoverageHours;

      // Minimum headcount assuming each person can work up to MAX hours/week
      securityStaffMin = Math.ceil(requiredStaffHoursPerWeek / MAX_HOURS_PER_STAFF_PER_WEEK);

      // Maximum headcount assuming each person only works MIN hours/week
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
      securityStaffMin,
      securityStaffMax
    };
  }

  // ----------------------------
  // Rendering
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

    // Layout: header + scene + footer
    const headerH = s.showLabels ? 54 : 0;
    const footerH = 110; // reserved footer band for truck estimates
    const sceneTop = headerH + 6;
    const sceneH = Math.max(10, usableH - headerH - footerH);

    // Header
    if (s.showLabels) {
      this.drawText(g, state.headline, usableW / 2, 18, { size: 14, weight: "700", color: "#111827" });
      this.drawText(g, state.subline, usableW / 2, 40, { size: 11, weight: "400", color: "#374151" });
    }

    // Scene group
    const sceneG = document.createElementNS("http://www.w3.org/2000/svg", "g");
    sceneG.setAttribute("transform", `translate(0, ${sceneTop})`);
    g.appendChild(sceneG);

    // Render buildings in a grid
    const buildings = state.inputs.mode === 1 ? state.inputs.buildings : new Array(Math.max(1, state.inputs.buildingCountGlobal || 1)).fill(0);
    const specs: BuildingSpec[] = state.inputs.mode === 1
      ? state.inputs.buildings
      : this.expandGlobalBuildings(state);

    const n = Math.max(1, specs.length);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);

    const cellW = usableW / cols;
    const cellH = sceneH / rows;

    // Landscaping influence (subtle)
    const spacingMul = clamp(0.9, 1.35, 1 + Math.log10(state.inputs.acreage + 1) / 12);

    for (let idx = 0; idx < n; idx++) {
      const r = Math.floor(idx / cols);
      const c = idx % cols;

      const ox = c * cellW;
      const oy = r * cellH;

      const cg = document.createElementNS("http://www.w3.org/2000/svg", "g");
      cg.setAttribute("transform", `translate(${ox}, ${oy})`);
      sceneG.appendChild(cg);

      const innerPad = 12 * spacingMul;
      const w = Math.max(50, cellW - innerPad * 2);
      const h = Math.max(50, cellH - innerPad * 2);

      const cx = innerPad + w / 2;
      const cy = innerPad + h / 2;

      const spec = specs[idx];

      if (s.showLandscaping) {
        this.drawLandscaping(cg, cx, cy, w, h);
      }

      // Render mode (author knob)
      const renderMode = s.renderMode; // "isometric" | "stack" ;

      if (renderMode === "isometric") {
        this.renderIsometricDatacenter(cg, cx, cy, w, h, spec, s);
      } else {
        this.renderFootprintStack(cg, innerPad, innerPad, w, h, spec, s);
      }
    }

    // Footer (Truck totals + throughput)
    this.drawFooter(g, usableW, usableH - footerH + 14, state);

    this.content.appendChild(svg);
  }

  private expandGlobalBuildings(state: RenderState): BuildingSpec[] {
    const count = clampInt(state.inputs.buildingCountGlobal || 1, 1, 20);
    const stories = clampInt(state.inputs.storiesGlobal || 1, 1, 20);
    const sqftPer = count > 0 ? (state.inputs.totalSqft / count) : 0;

    const arr: BuildingSpec[] = [];
    for (let i = 0; i < count; i++) {
      arr.push({ sqft: Math.max(0, sqftPer), stories });
    }
    return arr;
  }

  // ----------------------------
  // Aesthetics
  // ----------------------------

  private drawLandscaping(g: SVGGElement, cx: number, cy: number, w: number, h: number): void {
    // Simple ground plane (green ellipse) + a few shrub blobs
    const grass = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    grass.setAttribute("cx", `${cx}`);
    grass.setAttribute("cy", `${cy + h * 0.28}`);
    grass.setAttribute("rx", `${w * 0.46}`);
    grass.setAttribute("ry", `${h * 0.18}`);
    grass.setAttribute("fill", "rgba(34, 197, 94, 0.22)"); // soft green
    g.appendChild(grass);

    // Shrubs (random-ish deterministic positions)
    for (let i = 0; i < 3; i++) {
      const blob = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      const dx = (i - 1) * w * 0.14;
      const dy = (i % 2 === 0 ? 1 : -1) * h * 0.06;
      blob.setAttribute("cx", `${cx + dx}`);
      blob.setAttribute("cy", `${cy + h * 0.28 + dy}`);
      blob.setAttribute("r", `${Math.max(6, Math.min(w, h) * 0.04)}`);
      blob.setAttribute("fill", "rgba(34, 197, 94, 0.30)");
      g.appendChild(blob);
    }

    // Light “road” line
    const road = document.createElementNS("http://www.w3.org/2000/svg", "path");
    road.setAttribute("d", `M ${cx - w * 0.30} ${cy + h * 0.33} Q ${cx} ${cy + h * 0.38} ${cx + w * 0.30} ${cy + h * 0.33}`);
    road.setAttribute("fill", "none");
    road.setAttribute("stroke", "rgba(107,114,128,0.25)");
    road.setAttribute("stroke-width", "3");
    road.setAttribute("stroke-linecap", "round");
    g.appendChild(road);
  }

  private renderFootprintStack(
    g: SVGGElement,
    x0: number,
    y0: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: any
  ): void {
    // Simple fallback view
    const footprintZoneH = h * 0.55;
    const heightZoneH = h * 0.45;

    const footprintArea = Math.max(1, spec.sqft / Math.max(1, spec.stories));
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

    const floors = Math.min(200, Math.round(spec.stories));
    const floorH = Math.max(2, heightZoneH / Math.max(1, floors));
    const stackX = baseX + baseW * 0.15;
    const stackW = baseW * 0.70;
    const stackTopY = y0 + footprintZoneH + 8 + heightZoneH;

    for (let i = 0; i < floors; i++) {
      const yy = stackTopY - (i + 1) * floorH;
      const rr = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rr.setAttribute("x", `${stackX}`);
      rr.setAttribute("y", `${yy}`);
      rr.setAttribute("width", `${stackW}`);
      rr.setAttribute("height", `${floorH - 0.5}`);
      rr.setAttribute("fill", this.tint(s.fillColor, i / Math.max(1, floors)));
      rr.setAttribute("stroke", s.outlineColor);
      rr.setAttribute("stroke-width", `${Math.max(1, s.outlineWidth * 0.6)}`);
      rr.setAttribute("rx", "6");
      g.appendChild(rr);
    }
  }

  private renderIsometricDatacenter(
    g: SVGGElement,
    cx: number,
    cy: number,
    w: number,
    h: number,
    spec: BuildingSpec,
    s: any
  ): void {
    const stories = Math.max(1, Math.round(spec.stories));

    // Geometry
    const base = Math.min(w, h) * 0.32 + Math.sqrt(spec.sqft / stories) * 0.02;
    const height = Math.min(h * 0.72, Math.max(26, stories * 6));

    // Shadow
    const shadow = document.createElementNS("http://www.w3.org/2000/svg", "ellipse");
    shadow.setAttribute("cx", `${cx}`);
    shadow.setAttribute("cy", `${cy + height * 0.70}`);
    shadow.setAttribute("rx", `${base * 1.10}`);
    shadow.setAttribute("ry", `${base * 0.46}`);
    shadow.setAttribute("fill", "rgba(0,0,0,0.10)");
    g.appendChild(shadow);

    // Faces
    const top: Pt[] = [
      { x: cx, y: cy - base },
      { x: cx + base, y: cy - base * 0.5 },
      { x: cx, y: cy },
      { x: cx - base, y: cy - base * 0.5 }
    ];

    const front: Pt[] = [
      { x: cx - base, y: cy - base * 0.5 },                  // TL
      { x: cx, y: cy },                                      // TR
      { x: cx, y: cy + height },                             // BR
      { x: cx - base, y: cy + height - base * 0.5 }          // BL
    ];

    const side: Pt[] = [
      { x: cx, y: cy },                                      // TL
      { x: cx + base, y: cy - base * 0.5 },                  // TR
      { x: cx + base, y: cy + height - base * 0.5 },         // BR
      { x: cx, y: cy + height }                              // BL
    ];

    // Base fill colors
    this.poly(g, top, this.tint(s.fillColor, 0.25), s);
    this.poly(g, side, this.tint(s.fillColor, 0.45), s);
    this.poly(g, front, s.fillColor, s);

    // Windows & mech floors on FRONT face
    this.drawIsometricWindows(front, stories, {
      mechEvery: Math.max(2, Math.round(s.mechEvery ?? 4)),
      windowDensity: Math.max(0.4, Math.min(2.0, s.windowDensity ?? 1.0)),
      skipGroundFloor: true
    }, s);

    // Subtle highlight edge
    const edge = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    edge.setAttribute("points", `${top[0].x},${top[0].y} ${top[1].x},${top[1].y} ${side[2].x},${side[2].y}`);
    edge.setAttribute("fill", "none");
    edge.setAttribute("stroke", "rgba(255,255,255,0.55)");
    edge.setAttribute("stroke-width", "1");
    g.appendChild(edge);
  }

  private drawIsometricWindows(
    front: Pt[],
    stories: number,
    opts: { mechEvery: number; windowDensity: number; skipGroundFloor: boolean },
    s: any
  ): void {
    // front quad points are TL, TR, BR, BL
    const TL = front[0], TR = front[1], BR = front[2], BL = front[3];

    // floor bands from TOP->BOTTOM in v-space
    // v=0 top edge, v=1 bottom edge
    const floors = Math.max(1, stories);
    const band = 1 / floors;

    // window layout in u-space
    const baseCols = Math.max(4, Math.round(8 * opts.windowDensity));
    const marginU = 0.08;
    const marginV = 0.18;

    for (let f = 0; f < floors; f++) {
      // floorFromBottom: 1 = ground floor
      const floorFromBottom = floors - f;

      // skip ground floor windows for realism
      if (opts.skipGroundFloor && floorFromBottom === 1) {
        // Add small “vent slits” instead of windows (tiny horizontal strips)
        const v0 = f * band;
        const v1 = (f + 1) * band;
        this.drawVentSlitsOnQuad(TL, TR, BR, BL, v0, v1, s);
        continue;
      }

      const isMech = (floorFromBottom % opts.mechEvery === 0);

      // mech floors: fewer windows + slightly darker overlay strip
      const cols = isMech ? Math.max(2, Math.floor(baseCols * 0.55)) : baseCols;

      const v0 = f * band;
      const v1 = (f + 1) * band;

      if (isMech) {
        // dark overlay strip
        const strip = this.quadStripPolygon(TL, TR, BR, BL, v0, v1);
        strip.setAttribute("fill", "rgba(17,24,39,0.10)");
        strip.setAttribute("stroke", "none");
        s.__append(strip);
      }

      // window rect size (relative)
      const windowW = (1 - marginU * 2) / cols * 0.55;
      const gapW = (1 - marginU * 2) / cols * 0.45;
      const winV0 = v0 + band * marginV;
      const winV1 = v1 - band * marginV;

      for (let c = 0; c < cols; c++) {
        const u0 = marginU + c * (windowW + gapW);
        const u1 = u0 + windowW;

        // Subtle tint variation (deterministic)
        const jitter = hash01(f + 1, c + 1);
        const alpha = isMech ? 0.22 : 0.30;
        const tint = lerpNumber(0.0, 0.12, jitter); // tiny brightness variance
        const fill = rgbaTint("#E6F2FF", alpha, tint);

        const win = this.quadWindowPolygon(TL, TR, BR, BL, u0, u1, winV0, winV1, fill, s);
        s.__append(win);
      }
    }

    // little hack: append helper
    // (we can’t easily pass SVG group into this helper without bloating args)
    // We'll set it below in poly()
  }

  private drawVentSlitsOnQuad(TL: Pt, TR: Pt, BR: Pt, BL: Pt, v0: number, v1: number, s: any): void {
    // two thin horizontal slits
    const midV = (v0 + v1) / 2;
    const slitH = (v1 - v0) * 0.10;

    for (let i = 0; i < 2; i++) {
      const vv0 = midV + (i === 0 ? -slitH * 1.2 : slitH * 0.4);
      const vv1 = vv0 + slitH;

      const u0 = 0.18;
      const u1 = 0.82;

      const poly = this.quadStripPolygon(TL, TR, BR, BL, vv0, vv1, u0, u1);
      poly.setAttribute("fill", "rgba(17,24,39,0.12)");
      poly.setAttribute("stroke", "none");
      s.__append(poly);
    }
  }

  // Build a polygon representing a horizontal strip between v0..v1 (optionally with u0..u1)
  private quadStripPolygon(TL: Pt, TR: Pt, BR: Pt, BL: Pt, v0: number, v1: number, u0 = 0.0, u1 = 1.0): SVGPolygonElement {
    const p1 = quadPoint(TL, TR, BR, BL, u0, v0);
    const p2 = quadPoint(TL, TR, BR, BL, u1, v0);
    const p3 = quadPoint(TL, TR, BR, BL, u1, v1);
    const p4 = quadPoint(TL, TR, BR, BL, u0, v1);

    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y} ${p4.x},${p4.y}`);
    return poly;
  }

  private quadWindowPolygon(
    TL: Pt, TR: Pt, BR: Pt, BL: Pt,
    u0: number, u1: number, v0: number, v1: number,
    fill: string, s: any
  ): SVGPolygonElement {
    const p1 = quadPoint(TL, TR, BR, BL, u0, v0);
    const p2 = quadPoint(TL, TR, BR, BL, u1, v0);
    const p3 = quadPoint(TL, TR, BR, BL, u1, v1);
    const p4 = quadPoint(TL, TR, BR, BL, u0, v1);

    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    poly.setAttribute("points", `${p1.x},${p1.y} ${p2.x},${p2.y} ${p3.x},${p3.y} ${p4.x},${p4.y}`);
    poly.setAttribute("fill", fill);
    poly.setAttribute("stroke", "rgba(17,24,39,0.08)");
    poly.setAttribute("stroke-width", "0.6");
    poly.setAttribute("stroke-linejoin", "round");
    return poly;
  }

  // ----------------------------
  // Footer (Truck Estimates)
  // ----------------------------

  private drawFooter(g: SVGGElement, width: number, yTop: number, state: RenderState): void {
    // Bold summary first
    const title = `Estimated Total Trucks (Project Duration): ${fmt(state.totalTrucks)}`;
    this.drawText(g, title, width / 2, yTop, { size: 15, weight: "800", color: "#111827" });

    const line1 = `Buildings: ${fmt(state.buildingTrucks)} trucks  •  Site Infrastructure: ${fmt(state.infraTrucks)} trucks`;
    this.drawText(g, line1, width / 2, yTop + 22, { size: 11, weight: "400", color: "#374151" });

    // Throughput lines (only show if inputs provided)
    const { hoursPerDay, daysPerWeek, gates, projectWeeks } = state.inputs;

    const line2 =
      (projectWeeks > 0 && daysPerWeek > 0 && state.avgTrucksPerReceivingDay !== undefined)
        ? `Avg Trucks / Receiving Day: ${fmt(Math.ceil(state.avgTrucksPerReceivingDay))} (based on ${fmt(projectWeeks)} weeks × ${fmt(daysPerWeek)} days/week)`
        : `Avg Trucks / Receiving Day: N/A (provide Project Weeks + Days Per Week)`;

    this.drawText(g, line2, width / 2, yTop + 44, { size: 11, weight: "400", color: "#374151" });

    const line3 =
      (state.trucksPerHourPerGate !== undefined && hoursPerDay > 0 && gates > 0)
        ? `Trucks / Hour / Gate: ${state.trucksPerHourPerGate.toFixed(2)} (Hours/Day: ${fmt(hoursPerDay)} • Gates: ${fmt(gates)})`
        : `Trucks / Hour / Gate: N/A (provide Hours Per Day + Receiving Gates)`;

    this.drawText(g, line3, width / 2, yTop + 62, { size: 11, weight: "400", color: "#374151" });

    const line4 =
      (state.securityStaffMin !== undefined && state.securityStaffMax !== undefined)
        ? `Suggested Gate Security Staff: ${fmt(state.securityStaffMin)}–${fmt(state.securityStaffMax)} (2 per gate, ${fmt(daysPerWeek)} days/week, ${fmt(hoursPerDay)} hrs/day)`
        : `Suggested Gate Security Staff: N/A (provide Hours Per Day + Days Per Week + Receiving Gates)`;

    this.drawText(g, line4, width / 2, yTop + 82, { size: 11, weight: "600", color: "#111827" });
  }

  // ----------------------------
  // SVG helpers
  // ----------------------------

  private poly(g: SVGGElement, pts: Pt[], fill: string, s: any): void {
    // attach helper so drawIsometricWindows can append without threading g everywhere
    s.__append = (el: SVGElement) => g.appendChild(el);

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

  // Export snapshot
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
    const g = parseInt(c.substring(2, 4), 16);
    const b = parseInt(c.substring(4, 6), 16);
    const mix = (v: number) => Math.round(v + (255 - v) * Math.min(0.6, t * 0.6));
    return `rgb(${mix(r)}, ${mix(g)}, ${mix(b)})`;
  }
}

// ----------------------------
// Types + math helpers
// ----------------------------

type Pt = { x: number; y: number };

function quadPoint(TL: Pt, TR: Pt, BR: Pt, BL: Pt, u: number, v: number): Pt {
  // bilinear interpolation
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

function clamp(min: number, max: number, x: number): number {
  return Math.max(min, Math.min(max, x));
}

function fmt(n: number): string {
  return n.toLocaleString();
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function hash01(a: number, b: number): number {
  // deterministic pseudo-random 0..1
  const x = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function rgbaTint(hex: string, alpha: number, brighten: number): string {
  // brighten: 0..0.12-ish
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16);
  const g = parseInt(c.substring(2, 4), 16);
  const b = parseInt(c.substring(4, 6), 16);

  const rr = Math.min(255, Math.round(r + (255 - r) * brighten));
  const gg = Math.min(255, Math.round(g + (255 - g) * brighten));
  const bb = Math.min(255, Math.round(b + (255 - b) * brighten));

  return `rgba(${rr},${gg},${bb},${alpha})`;
}