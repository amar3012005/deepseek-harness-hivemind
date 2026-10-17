# Five-message initial HIVE chat window

The existing session event stream opens HIVE routes with five messages and retains native fifty-message cursor pagination for older history. Live streams, projections, model context and saved events are unchanged. Browser switching reuses the existing session manager. Native non-HIVE routes retain their previous initial window.

Acceptance separates focused pagination tests, compiled browser assets, deployed image and visual scroll/switch checks. Visual checks remain pending until performed with the user.
