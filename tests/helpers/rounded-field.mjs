import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function checkRoundedField(field, name) {
  const directory = process.env.KAMI_FIELD_SCREENSHOTS || process.env.KAMI_UI_SCREENSHOTS;
  await field.evaluate((el) => { el.blur(); el.scrollIntoView({ block: "center" }); });
  const shape = () => field.evaluate((el) => {
    const css = getComputedStyle(el);
    return {
      bounds: el.getBoundingClientRect().toJSON(),
      corners: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius],
      border: css.borderTopWidth, color: css.borderTopColor, appearance: css.appearance,
      outline: css.outlineStyle, shadow: css.boxShadow, clip: css.backgroundClip
    };
  });
  const frame = async (state) => {
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const box = await field.boundingBox(), margin = 8;
    await field.page().screenshot({ path: join(directory, `${name}-${state}.png`), animations: "disabled",
      clip: { x: box.x - margin, y: box.y - margin, width: box.width + 2 * margin, height: box.height + 2 * margin } });
  };
  const rest = await shape();
  await frame("rest");
  await field.focus();
  const focus = await shape();
  await frame("focused");
  for (const state of [rest, focus]) {
    assert.deepEqual(state.corners, Array(4).fill("12px"));
    assert.equal(state.appearance, "none");
    assert.equal(state.border, "2px");
    assert.equal(state.clip, "padding-box");
  }
  assert.deepEqual(focus.bounds, rest.bounds);
  assert.notEqual(focus.color, rest.color);
  assert.equal(focus.outline, "none");
  assert.equal(focus.shadow, "none");
}
