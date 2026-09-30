/**
 * The page-side half of `text-fit.spec.ts`: a detector that measures the
 * rendered page and reports text that does not fit.
 *
 * - `cramped`: the text of a bordered or filled box (a button, a card, a
 *   row, a chip, a badge, a banner) comes closer than `vertical` px to its
 *   top or bottom padding edge, or closer than `horizontal` px to its left
 *   or right one, or the box's content is taller than its inside. Only the
 *   edges a reader can see count: a border on that side, or a fill that
 *   differs from the one behind the box.
 * - `clipped`: an element that hides its overflow (`overflow: hidden` or
 *   `clip`, which `truncate` and `line-clamp` use) holds text that runs past
 *   its padding box.
 * - `overflow`: the page scrolls sideways, text runs past the viewport, or
 *   a box with text (a button, a chip) sticks out of the bordered or filled
 *   box around it.
 * - `overlap`: the visible text of two nearby elements, or text and an
 *   icon, is drawn over each other.
 * - `squeezed`: a sentence squeezed into a column so narrow that it breaks
 *   after nearly every word (four lines or more, under 14 characters a
 *   line): what a row does when a button or a badge beside it takes the
 *   width.
 * - A scroll container that scrolls sideways counts as `overflow` too.
 *
 * Invisible, zero-size and `aria-hidden` text is left out, and so is text
 * that lies wholly off screen to the side (the closed drawer). Text inside a
 * scroll container is measured against boxes inside it only, and only its
 * visible part counts for overlaps: what is scrolled away is not clipped.
 *
 * `detectTextFit` is handed to `page.evaluate`, so it is self-contained:
 * every helper lives inside it.
 */

export type TextFitKind = "cramped" | "clipped" | "overflow" | "overlap" | "squeezed";

export interface TextFitHit {
  kind: TextFitKind;
  /** Stable across widths, languages and data: where it is, the tag and the class list. */
  key: string;
  /** A CSS selector of the element on this page, for a screenshot. */
  path: string;
  /** The nearest name the markup gives: a test id, a role, a label. */
  component: string;
  /** The text involved, cut to 200 characters. */
  text: string;
  /** The text of the nearest control around it (button, link, row), cut to 120 characters. */
  control: string;
  rect: { x: number; y: number; width: number; height: number };
  detail: Record<string, number | string | boolean>;
}

export interface TextFitOptions {
  /** The least room, in px, between text and a top or bottom edge. */
  vertical: number;
  /** The least room, in px, between text and a left or right edge. */
  horizontal: number;
  /** Measures only inside the last element this selector matches, such as an open dialog. */
  scope?: string;
}

export function detectTextFit(options: TextFitOptions): TextFitHit[] {
  interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
  }

  const hits: TextFitHit[] = [];
  const root: Element =
    options.scope === undefined ? document.body : (Array.from(document.querySelectorAll(options.scope)).pop() ?? document.body);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const styles = new Map<Element, CSSStyleDeclaration>();
  const style = (element: Element): CSSStyleDeclaration => {
    let computed = styles.get(element);
    if (computed === undefined) {
      computed = getComputedStyle(element);
      styles.set(element, computed);
    }
    return computed;
  };
  const round = (value: number) => Math.round(value * 10) / 10;
  const clean = (text: string | null, max: number) => {
    const flat = (text ?? "").replace(/\s+/g, " ").trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  };

  const alphaOf = (color: string): number => {
    if (color === "" || color === "transparent") return 0;
    const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
    if (slash !== null) return slash[2] === "%" ? Number(slash[1]) / 100 : Number(slash[1]);
    const rgba = /^rgba\(([^)]+)\)$/.exec(color);
    if (rgba !== null) {
      const parts = rgba[1].split(",");
      if (parts.length === 4) return Number(parts[3]);
    }
    return 1;
  };

  const shown = (element: Element): boolean => {
    const check = (element as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility;
    if (typeof check === "function" && !check.call(element, { checkOpacity: true, checkVisibilityCSS: true })) return false;
    return element.closest('[aria-hidden="true"]') === null;
  };

  const clipsX = (element: Element) => /hidden|clip/.test(style(element).overflowX);
  const clipsY = (element: Element) => /hidden|clip/.test(style(element).overflowY);
  const scrollsX = (element: Element) => /auto|scroll/.test(style(element).overflowX);
  const scrollsY = (element: Element) => /auto|scroll/.test(style(element).overflowY);
  const scrolls = (element: Element) => scrollsX(element) || scrollsY(element);

  /** The padding box: inside the borders, without a scroll bar. */
  const paddingBox = (element: Element): Box => {
    const rect = element.getBoundingClientRect();
    const left = rect.left + element.clientLeft;
    const top = rect.top + element.clientTop;
    const width = element.clientWidth || rect.width;
    const height = element.clientHeight || rect.height;
    return { left, top, right: left + width, bottom: top + height };
  };

  const describe = (element: Element): string => {
    const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
    const role = element.getAttribute("role") ?? element.closest("[role]")?.getAttribute("role");
    const label = element.getAttribute("aria-label");
    const classes = (element.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
    return [
      testId !== undefined && testId !== null ? `[data-testid=${testId}]` : "",
      role !== null && role !== undefined ? `role=${role}` : "",
      label !== null ? `aria-label="${clean(label, 40)}"` : "",
      `<${element.tagName.toLowerCase()} class="${classes}">`,
    ]
      .filter(Boolean)
      .join(" ");
  };

  const anchorOf = (element: Element): string => {
    const testId = element.closest("[data-testid]")?.getAttribute("data-testid");
    if (testId !== undefined && testId !== null) return testId;
    if (element.closest("[role=dialog]") !== null) return "dialog";
    const pane = element.closest("[data-pane]")?.getAttribute("data-pane");
    if (pane !== undefined && pane !== null) return `pane:${pane}`;
    return "page";
  };

  const signature = (element: Element): string => {
    const classes = (element.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).join(".");
    return `${anchorOf(element)}|${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`}`;
  };

  const pathOf = (element: Element): string => {
    const parts: string[] = [];
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      const parent: Element | null = node.parentElement;
      const index = parent === null ? 1 : Array.prototype.indexOf.call(parent.children, node) + 1;
      const testId = node.getAttribute("data-testid");
      parts.unshift(`${node.tagName.toLowerCase()}${testId !== null ? `[data-testid="${testId}"]` : ""}:nth-child(${index})`);
    }
    return ["body", ...parts].join(" > ");
  };

  const controlOf = (element: Element): string =>
    clean(element.closest("button, a, label, [role=button], [role=row], [role=option], [role=alert], [role=status], li")?.textContent ?? "", 120);

  const rectOf = (element: Element) => {
    const rect = element.getBoundingClientRect();
    return { x: round(rect.left), y: round(rect.top), width: round(rect.width), height: round(rect.height) };
  };

  const push = (kind: TextFitKind, element: Element, text: string, detail: TextFitHit["detail"], key = signature(element)) => {
    hits.push({
      kind,
      key,
      path: pathOf(element),
      component: describe(element),
      text: clean(text, 200),
      control: controlOf(element),
      rect: rectOf(element),
      detail,
    });
  };

  const intersect = (a: Box, b: Box): Box => ({
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  });
  const empty = (box: Box) => box.right - box.left <= 0.5 || box.bottom - box.top <= 0.5;

  /** A box with edges a reader sees: which sides, and whether it is filled. */
  const backgroundBehind = (element: Element | null): string => {
    for (let node = element; node !== null; node = node.parentElement) {
      const color = style(node).backgroundColor;
      if (alphaOf(color) > 0.02) return color;
    }
    return "canvas";
  };
  const edgesOf = (element: Element): { top: boolean; right: boolean; bottom: boolean; left: boolean; filled: boolean } | null => {
    if (element === document.body || element === document.documentElement) return null;
    const computed = style(element);
    const side = (width: string, lineStyle: string, color: string) =>
      parseFloat(width) > 0.4 && lineStyle !== "none" && lineStyle !== "hidden" && alphaOf(color) > 0.05;
    const top = side(computed.borderTopWidth, computed.borderTopStyle, computed.borderTopColor);
    const right = side(computed.borderRightWidth, computed.borderRightStyle, computed.borderRightColor);
    const bottom = side(computed.borderBottomWidth, computed.borderBottomStyle, computed.borderBottomColor);
    const left = side(computed.borderLeftWidth, computed.borderLeftStyle, computed.borderLeftColor);
    const fill =
      alphaOf(computed.backgroundColor) > 0.02 && computed.backgroundColor !== backgroundBehind(element.parentElement);
    const ring = /(^|,\s*)(\S+\s+)?0px 0px 0px [1-9]/.test(computed.boxShadow);
    const filled = fill || computed.backgroundImage !== "none" || ring;
    if (!filled && !top && !right && !bottom && !left) return null;
    return { top: filled || top, right: filled || right, bottom: filled || bottom, left: filled || left, filled };
  };

  // ---------------------------------------------------------------------
  // The text on the page, line by line.
  // ---------------------------------------------------------------------

  interface TextItem {
    node: Text;
    parent: Element;
    /** The line boxes as laid out. */
    lines: Box[];
    /** The same, cut by every ancestor that hides or scrolls its overflow. */
    visible: Box[];
    depth: number;
  }

  const depthOf = (element: Element) => {
    let depth = 0;
    for (let node: Element | null = element; node !== null; node = node.parentElement) depth += 1;
    return depth;
  };

  /**
   * Inside a box of at most 2 by 2 px that hides its overflow: `sr-only`.
   * A box squeezed to no width but a line's height is a finding instead.
   */
  const visuallyHidden = (element: Element) => (clipsX(element) || clipsY(element)) && element.clientWidth <= 2 && element.clientHeight <= 2;
  const hiddenForReadersOnly = (element: Element): boolean => {
    for (let node: Element | null = element; node !== null && node !== document.body; node = node.parentElement) {
      if (visuallyHidden(node)) return true;
    }
    return false;
  };

  const texts: TextItem[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode() as Text | null; node !== null; node = walker.nextNode() as Text | null) {
    if ((node.textContent ?? "").trim() === "") continue;
    const parent = node.parentElement;
    if (parent === null || parent.closest("script, style, noscript, template, textarea, select, option") !== null) continue;
    if (!shown(parent)) continue;
    range.selectNodeContents(node);
    const lines = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0.5 && rect.height > 0.5)
      .map((rect) => ({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }));
    if (lines.length === 0) continue;
    // Wholly off screen to the side: the closed drawer, a slid-away panel.
    if (lines.every((line) => line.right <= 0 || line.left >= vw)) continue;
    let visible = lines;
    for (let ancestor: Element | null = parent; ancestor !== null && ancestor !== document.documentElement; ancestor = ancestor.parentElement) {
      const cutX = clipsX(ancestor) || scrollsX(ancestor);
      const cutY = clipsY(ancestor) || scrollsY(ancestor);
      if (cutX || cutY) {
        const inside = paddingBox(ancestor);
        visible = visible
          .map((line) => ({
            left: cutX ? Math.max(line.left, inside.left) : line.left,
            right: cutX ? Math.min(line.right, inside.right) : line.right,
            top: cutY ? Math.max(line.top, inside.top) : line.top,
            bottom: cutY ? Math.min(line.bottom, inside.bottom) : line.bottom,
          }))
          .filter((line) => !empty(line));
        if (visible.length === 0) break;
      }
      // A fixed box escapes the clipping of the boxes around it: a toast off
      // the edge of the screen is not hidden by a page that hides its overflow.
      if (style(ancestor).position === "fixed") break;
    }
    if (visible.length === 0 && hiddenForReadersOnly(parent)) continue;
    texts.push({ node, parent, lines, visible, depth: depthOf(parent) });
  }

  // ---------------------------------------------------------------------
  // (a) Cramped: text against the edges of its box.
  // ---------------------------------------------------------------------

  interface BoxReport {
    box: Element;
    edges: NonNullable<ReturnType<typeof edgesOf>>;
    top: number;
    right: number;
    bottom: number;
    left: number;
    sample: string;
    /** Line boxes of the worst text. */
    lines: number;
    worst: number;
  }
  const boxReports = new Map<Element, BoxReport>();
  const boxOf = new Map<Element, Element | null>();

  const findBox = (start: Element): Element | null => {
    if (boxOf.has(start)) return boxOf.get(start) ?? null;
    let found: Element | null = null;
    for (let node: Element | null = start; node !== null && node !== document.body; node = node.parentElement) {
      const edges = edgesOf(node);
      if (edges !== null) {
        const rect = node.getBoundingClientRect();
        // A pane or a page, not a control: its text sits in rows of its own.
        const layout = rect.width >= vw * 0.95 && rect.height >= vh * 0.5;
        if (!layout && !scrolls(node) && style(node).position !== "fixed") found = node;
        break;
      }
      // Text that scrolls is measured against boxes inside the scroll container only.
      if (scrolls(node)) break;
    }
    boxOf.set(start, found);
    return found;
  };

  for (const item of texts) {
    const box = findBox(item.parent);
    if (box === null) continue;
    const edges = edgesOf(box);
    if (edges === null) continue;
    // What of the text shows inside the box: cut by the clipping elements
    // between the text and the box, the box included.
    let lines = item.lines;
    for (let ancestor: Element | null = item.parent; ancestor !== null; ancestor = ancestor.parentElement) {
      const cutX = clipsX(ancestor);
      const cutY = clipsY(ancestor);
      if (cutX || cutY) {
        const inside = paddingBox(ancestor);
        lines = lines
          .map((line) => ({
            left: cutX ? Math.max(line.left, inside.left) : line.left,
            right: cutX ? Math.min(line.right, inside.right) : line.right,
            top: cutY ? Math.max(line.top, inside.top) : line.top,
            bottom: cutY ? Math.min(line.bottom, inside.bottom) : line.bottom,
          }))
          .filter((line) => !empty(line));
      }
      if (ancestor === box) break;
    }
    if (lines.length === 0) continue;
    const rect = box.getBoundingClientRect();
    const computed = style(box);
    const inner = {
      left: rect.left + parseFloat(computed.borderLeftWidth),
      right: rect.right - parseFloat(computed.borderRightWidth),
      top: rect.top + parseFloat(computed.borderTopWidth),
      bottom: rect.bottom - parseFloat(computed.borderBottomWidth),
    };
    const text = {
      left: Math.min(...lines.map((line) => line.left)),
      right: Math.max(...lines.map((line) => line.right)),
      top: Math.min(...lines.map((line) => line.top)),
      bottom: Math.max(...lines.map((line) => line.bottom)),
    };
    const gaps = {
      top: text.top - inner.top,
      right: inner.right - text.right,
      bottom: inner.bottom - text.bottom,
      left: text.left - inner.left,
    };
    let report = boxReports.get(box);
    if (report === undefined) {
      report = { box, edges, top: Infinity, right: Infinity, bottom: Infinity, left: Infinity, sample: "", lines: 0, worst: Infinity };
      boxReports.set(box, report);
    }
    const shortfall = Math.min(
      edges.top ? gaps.top - options.vertical : Infinity,
      edges.bottom ? gaps.bottom - options.vertical : Infinity,
      edges.left ? gaps.left - options.horizontal : Infinity,
      edges.right ? gaps.right - options.horizontal : Infinity,
    );
    report.top = Math.min(report.top, gaps.top);
    report.right = Math.min(report.right, gaps.right);
    report.bottom = Math.min(report.bottom, gaps.bottom);
    report.left = Math.min(report.left, gaps.left);
    if (shortfall < report.worst) {
      report.worst = shortfall;
      report.sample = item.node.textContent ?? "";
      report.lines = new Set(item.lines.map((line) => Math.round(line.top))).size;
    }
  }

  for (const report of boxReports.values()) {
    const { box, edges } = report;
    const tight: string[] = [];
    if (edges.top && report.top < options.vertical) tight.push("top");
    if (edges.bottom && report.bottom < options.vertical) tight.push("bottom");
    if (edges.left && report.left < options.horizontal) tight.push("left");
    if (edges.right && report.right < options.horizontal) tight.push("right");
    const computed = style(box);
    const overflowing = computed.overflowY === "visible" && box.scrollHeight > box.clientHeight + 1 && box.clientHeight > 0;
    if (tight.length === 0 && !overflowing) continue;
    push("cramped", box, report.sample, {
      sides: tight.join(","),
      top: round(report.top),
      right: round(report.right),
      bottom: round(report.bottom),
      left: round(report.left),
      filled: edges.filled,
      lines: report.lines,
      escapes: report.top < 0 || report.bottom < 0 || report.left < 0 || report.right < 0,
      height: round(box.getBoundingClientRect().height),
      heightCss: computed.height,
      minHeight: computed.minHeight,
      padding: computed.padding,
      contentHeight: box.scrollHeight,
      innerHeight: box.clientHeight,
      contentOverflows: overflowing,
    });
  }

  // ---------------------------------------------------------------------
  // (b) Clipped: text an element hides past its padding box.
  // ---------------------------------------------------------------------

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const x = clipsX(element);
    const y = clipsY(element);
    if (!x && !y) continue;
    // Visually hidden for screen readers (`sr-only`), or no line high.
    if (visuallyHidden(element) || element.clientHeight <= 2) continue;
    const wide = x && element.scrollWidth > element.clientWidth + 1;
    const tall = y && element.scrollHeight > element.clientHeight + 1;
    if (!wide && !tall) continue;
    if (!shown(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.right <= 0 || rect.left >= vw) continue;
    // Only text counts: an image cut to a circle is decoration.
    const inside = paddingBox(element);
    const cut = texts.filter(
      (item) =>
        element.contains(item.node) &&
        item.lines.some(
          (line) =>
            (x && (line.right > inside.right + 1 || line.left < inside.left - 1)) ||
            (y && (line.bottom > inside.bottom + 1 || line.top < inside.top - 1)),
        ),
    );
    if (cut.length === 0) continue;
    const computed = style(element);
    const clamp = computed.getPropertyValue("-webkit-line-clamp");
    push("clipped", element, cut.map((item) => item.node.textContent ?? "").join(" "), {
      ellipsis: computed.textOverflow === "ellipsis",
      lineClamp: clamp === "" ? "none" : clamp,
      whiteSpace: computed.whiteSpace,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      hiddenX: wide ? element.scrollWidth - element.clientWidth : 0,
      hiddenY: tall ? element.scrollHeight - element.clientHeight : 0,
    });
  }

  // ---------------------------------------------------------------------
  // (c) Overflow: the page scrolls sideways, or text runs off the screen.
  // ---------------------------------------------------------------------

  const scroller = document.scrollingElement ?? document.documentElement;
  if (scroller.scrollWidth > vw + 1) {
    const culprits = Array.from(document.body.querySelectorAll("*"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || rect.right <= vw + 1) return false;
        for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
          if (scrollsX(node) || clipsX(node)) return false;
        }
        return shown(element);
      })
      .filter((element, _, all) => !all.some((other) => other !== element && element.contains(other)));
    push("overflow", culprits[0] ?? document.body, culprits.map((element) => element.textContent ?? "").join(" "), {
      scrollWidth: scroller.scrollWidth,
      innerWidth: vw,
      culprits: culprits.slice(0, 5).map(pathOf).join(" | "),
    }, `page|${culprits.slice(0, 3).map(signature).join(" + ")}`);
  }
  // A pane or a row that scrolls sideways because something in it is too wide.
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (!scrollsX(element) || element.scrollWidth <= element.clientWidth + 1 || element.clientWidth <= 2) continue;
    if (!shown(element) || (element.textContent ?? "").trim() === "") continue;
    const inside = paddingBox(element);
    const wide = Array.from(element.querySelectorAll("*")).filter((child) => {
      const rect = child.getBoundingClientRect();
      return rect.width > 0 && (rect.right > inside.right + 1 || rect.left < inside.left - 1) && shown(child);
    });
    const culprits = wide.filter((child) => !wide.some((other) => other !== child && child.contains(other)));
    push("overflow", element, culprits.map((child) => child.textContent ?? "").join(" "), {
      scrollsSideways: true,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      culprits: culprits.slice(0, 3).map(describe).join(" | "),
      culpritPaths: culprits.slice(0, 3).map(pathOf).join(" | "),
    });
  }

  // A sentence broken after nearly every word.
  for (const item of texts) {
    const text = (item.node.textContent ?? "").trim();
    const rows = new Set(item.lines.map((line) => Math.round(line.top))).size;
    if (rows < 4 || text.length / rows >= 14 || !/\s/.test(text)) continue;
    const width = item.parent.getBoundingClientRect().width;
    push("squeezed", item.parent, text, { lines: rows, charsPerLine: round(text.length / rows), width: round(width) });
  }

  for (const item of texts) {
    const beyond = item.visible.some((line) => line.right > vw + 1 || line.left < -1);
    if (!beyond) continue;
    push("overflow", item.parent, item.node.textContent ?? "", {
      right: round(Math.max(...item.visible.map((line) => line.right))),
      left: round(Math.min(...item.visible.map((line) => line.left))),
      innerWidth: vw,
    });
  }

  // A box with text that sticks out of the box around it: a button wider
  // than its card. Placed boxes (`absolute`, `fixed`) sit where they are
  // put on purpose; a box that hides its overflow is (b)'s.
  for (const element of Array.from(root.querySelectorAll("*"))) {
    if (edgesOf(element) === null || /absolute|fixed|sticky/.test(style(element).position)) continue;
    if ((element.textContent ?? "").trim() === "" || !shown(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0 || rect.right <= 0 || rect.left >= vw) continue;
    let outer: Element | null = null;
    for (let node = element.parentElement; node !== null && node !== document.body; node = node.parentElement) {
      if (scrolls(node) || clipsX(node) || clipsY(node)) break;
      if (edgesOf(node) !== null) {
        outer = node;
        break;
      }
    }
    if (outer === null) continue;
    const around = outer.getBoundingClientRect();
    const computed = style(outer);
    const inner = {
      left: around.left + parseFloat(computed.borderLeftWidth),
      right: around.right - parseFloat(computed.borderRightWidth),
      top: around.top + parseFloat(computed.borderTopWidth),
      bottom: around.bottom - parseFloat(computed.borderBottomWidth),
    };
    const out = {
      left: inner.left - rect.left,
      right: rect.right - inner.right,
      top: inner.top - rect.top,
      bottom: rect.bottom - inner.bottom,
    };
    const sides = (Object.keys(out) as Array<keyof typeof out>).filter((side) => out[side] > 1);
    if (sides.length === 0) continue;
    push("overflow", element, element.textContent ?? "", {
      escapes: sides.join(","),
      by: round(Math.max(...sides.map((side) => out[side]))),
      container: describe(outer),
      containerPath: pathOf(outer),
    });
  }

  // ---------------------------------------------------------------------
  // (d) Overlap: visible text over nearby text or an icon.
  // ---------------------------------------------------------------------

  interface Mark {
    element: Element;
    boxes: Box[];
    depth: number;
    icon: boolean;
    text: string;
  }
  const marks: Mark[] = texts
    .filter((item) => item.visible.length > 0)
    .map((item) => ({ element: item.parent, boxes: item.visible, depth: item.depth, icon: false, text: item.node.textContent ?? "" }));
  for (const svg of Array.from(root.querySelectorAll("svg"))) {
    if (svg.parentElement?.closest("svg") !== null && svg.parentElement?.closest("svg") !== undefined) continue;
    const check = (svg as Element & { checkVisibility?: (options: object) => boolean }).checkVisibility;
    if (typeof check === "function" && !check.call(svg, { checkOpacity: true, checkVisibilityCSS: true })) continue;
    const rect = svg.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4 || rect.right <= 0 || rect.left >= vw) continue;
    marks.push({
      element: svg,
      boxes: [{ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }],
      depth: depthOf(svg),
      icon: true,
      text: "",
    });
  }
  const bounds = marks.map((mark) => ({
    left: Math.min(...mark.boxes.map((box) => box.left)),
    top: Math.min(...mark.boxes.map((box) => box.top)),
    right: Math.max(...mark.boxes.map((box) => box.right)),
    bottom: Math.max(...mark.boxes.map((box) => box.bottom)),
  }));
  const commonDepth = (a: Element, b: Element): number => {
    for (let node: Element | null = a; node !== null; node = node.parentElement) {
      if (node.contains(b)) return depthOf(node);
    }
    return 0;
  };
  const layers = new Map<Element, Element | null>();
  const layerOf = (element: Element): Element | null => {
    if (layers.has(element)) return layers.get(element) ?? null;
    let layer: Element | null = null;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (node.matches("[role=dialog], [aria-modal=true]") || style(node).position === "fixed") {
        layer = node;
        break;
      }
    }
    layers.set(element, layer);
    return layer;
  };
  const seenPairs = new Set<string>();
  for (let i = 0; i < marks.length; i += 1) {
    for (let j = i + 1; j < marks.length; j += 1) {
      const a = marks[i];
      const b = marks[j];
      if (a.icon && b.icon) continue;
      if (a.element === b.element) continue;
      const outer = intersect(bounds[i], bounds[j]);
      if (outer.right - outer.left <= 2 || outer.bottom - outer.top <= 2) continue;
      let worst: Box | null = null;
      for (const boxA of a.boxes) {
        for (const boxB of b.boxes) {
          const both = intersect(boxA, boxB);
          if (both.right - both.left > 2 && both.bottom - both.top > 2) worst = both;
        }
      }
      if (worst === null) continue;
      // A dialog, a drawer or a sheet over the page is not an overlap.
      if (layerOf(a.element) !== layerOf(b.element)) continue;
      // Nearby elements only.
      const common = commonDepth(a.element, b.element);
      if (a.depth - common > 4 || b.depth - common > 4) continue;
      // A badge placed on an icon on purpose.
      const layered = (mark: Mark) => /absolute|fixed/.test(style(mark.element).position) || mark.element.closest("[class*=absolute]") !== null;
      if ((a.icon || b.icon) && (layered(a) || layered(b))) continue;
      const pair = `${signature(a.element)} ⨯ ${signature(b.element)}`;
      if (seenPairs.has(pair)) continue;
      seenPairs.add(pair);
      const textMark = a.icon ? b : a;
      push("overlap", textMark.element, [a.text, b.text].filter(Boolean).join(" ⨯ "), {
        with: pathOf(a.icon ? a.element : b.element),
        withComponent: describe(a.icon ? a.element : b.element),
        icon: a.icon || b.icon,
        overlapWidth: round(worst.right - worst.left),
        overlapHeight: round(worst.bottom - worst.top),
      }, pair);
    }
  }

  return hits;
}
