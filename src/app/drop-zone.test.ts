import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropZone } from "./drop-zone";

function render(working: boolean): string {
  return renderToStaticMarkup(createElement(DropZone, { onDrop: () => {}, working }));
}

/** The attributes of the Browse files button. */
function browseButton(html: string): string {
  const attrs = /<button([^>]*)>Browse files<\/button>/.exec(html)?.[1];
  if (attrs === undefined) throw new Error("no Browse files button");
  return attrs;
}

describe("DropZone", () => {
  it("leaves Browse files in the tab order, so the keyboard can reach the picker", () => {
    const attrs = browseButton(render(false));
    expect(attrs).toContain('type="button"');
    expect(attrs).not.toContain("tabindex");
    expect(attrs).not.toContain("disabled");
  });

  it("disables Browse files while working, when the zone ignores clicks", () => {
    expect(browseButton(render(true))).toContain("disabled");
  });

  it("does not make the zone focusable, idle or working", () => {
    // Chromium ignores role="presentation" on a focusable element, and the
    // zone then reads as an unnamed generic element.
    for (const working of [false, true]) {
      const html = render(working);
      expect(html).toMatch(/^<div role="presentation"/);
      expect(/^<div([^>]*)>/.exec(html)?.[1]).not.toContain("tabindex");
      // The file input stays out of the tab order too.
      expect(html).toMatch(/<input[^>]*tabindex="-1"/);
    }
  });
});
