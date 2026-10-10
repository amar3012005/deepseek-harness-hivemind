# Agent Note: Defer native PDF binary resources

Status: implemented

## Problem

The native application startup batch eagerly transfers the PDF worker, font data, CMaps and image decoders inside the preview plugin even when no PDF is open. The deployed preview plugin is approximately 6.89 MB decoded.

## Decision

Keep native PDF.js and preview lifecycle ownership, and move same-version binary resources into a build-owned static library exposed through the existing web seed. Its loader imports a separate Vite chunk only when openPdf initializes. After resource loading, abort is checked before Worker creation. The loader has no network fallback.

## Alternatives considered

Global asset caching would mix static bytes and tenant-sensitive bootstrap semantics. Moving the entire preview lifecycle would introduce unnecessary registration changes. A raw import left external in the published static artifact would require runtime package resolution; the resources build explicitly embeds its worker text before Vite.

## Consequences

The preview plugin is approximately 966 KB decoded, with a separate approximately 5.90 MB resource chunk deferred until first use. Unit checks preserve worker failures, cancellation and teardown. The compiled browser proof verifies zero resource requests at startup and factory registration, one first-use request and two real pages rendered through a real worker. Production wall-clock improvement remains a measured candidate/release acceptance check.
