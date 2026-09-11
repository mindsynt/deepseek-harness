# Agent Note: Image input and reasoning levels on the model row

Status: implemented

English | [中文](2026-09-11-model-row-image-input-and-reasoning-levels.zh.md)

## Problem

A model entered by hand under a custom provider is treated as text-only until it declares image input, and its model picker offers no Effort menu until it declares reasoning levels. Both declarations live only in the pi-ai profile's `models[]` entries, and the Models page — the surface most users open — had no control for either: a row exposed id, display name, context window, and max output tokens, and stopped there. The two gaps surfaced at different altitudes. An image attached to a hand-entered model was refused before it was sent and named the model, with the fix documented only as a `settings.yaml` recipe. And a route whose gateway does reason offered only the endpoint's own default, so a user who could not find an effort control could not tell whether the model thought at all.

## Decision

The model row's **Advanced** fold now offers both declarations and writes the same `models[]` entries `settings.yaml` uses, so the page and the file stay interchangeable rather than the page being a lossy subset of it.

**Image input** — **Inherit** / **Text only** / **Text and images**: Inherit leaves `input` absent so the installed catalog's record wins and the route's `defaultInput` answers for a model the catalog does not describe; Text only writes `input: [text]`; Text and images writes `input: [text, image]`.

**Reasoning effort** — **Inherit** / **Disabled** / **Custom levels**: Inherit removes the key so the installed catalog's levels stand; Disabled writes `reasoningEfforts: false`; Custom levels opens a level editor over `REASONING_LEVELS` (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). Each level is a checkbox beside a wire-value field, and the wire field is enabled only for a checked level. Switching into Custom levels seeds `{ off: null, high: 'high', max: 'max' }`, the profile shape the [per-model reasoning declarations](../../archived/feature/2026-08-08-pi-ai-per-model-reasoning-declarations.md) decision documented, so the first write is serviceable instead of an empty map the adapter would refuse. A blank wire value on a checked level stores `null`, the "don't send the field" form `off` uses.

`validateDeepSeekModels` now rejects both shapes before a write, mirroring the adapter's profile schema: image input must list only `text` and `image`; a `reasoningEfforts` map may name only known levels, must give every level beyond `off` a wire value, and must offer at least one thinking level beyond `off`. `false` and an absent key are both accepted.

## Alternatives considered

**Keep both fields yaml-only and link the `settings.yaml` recipe from the row.** The recipe already served people who edit settings, but the image refusal landed at send time — the user had already attached the image before learning the model needed a declaration — and the effort absence was not diagnosable at all: a missing Effort entry says nothing about whether the model can reason or whether it is simply undeclared.

**Offer them as route-level controls instead of per row.** Route-level `defaultInput` and `reasoning` already exist as fallbacks, and a route control would be two fields instead of two per row. But the models under one route disagree: a gateway serves text-only and vision models side by side, and one route's models disagree about which levels they accept. A route control could not express both kinds without narrowing or enabling every model on the route.

**Render the levels as one comma-separated text field.** The wire values are short strings, but a single field cannot express "off sends nothing and every other level needs a value" — the distinction the whole feature turns on — and a typo in a level name would surface only when the adapter rejected the request.

## Consequences

A hand-entered model can be fully declared on the page where it is configured: both the image refusal and the blank Effort menu become visible at configuration time, and the same entry can still be edited by hand in `settings.yaml`, because the page writes the adapter's own shape rather than a page-local one. The Advanced fold now carries four fields and the level editor is the largest control on the page; its hint carries the off/blank rule the picker menu cannot state. `settings.yaml` remains the home of the fields the form does not take — compatibility switches, headers, timeouts, retry policy, and the route-level `defaultInput` and `reasoning` fallbacks.
