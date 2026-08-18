# @puji4810/dsh-mermaid

Web client support for ` ```mermaid ` fences, bundled as a sibling of
`@puji4810/dsh-tikz`. The host half serves the official Mermaid browser
bundle from `/dsh-mermaid/mermaid.min.js`; the client half installs it, then
turns every settled Mermaid code fence — matched by the `language-mermaid`
class or its visible info-string banner — into an SVG in place, following the
page's `prefers-color-scheme`. Renders are serialized, guarded by a per-diagram
timeout, and failures keep the source in an expandable diagnostic block instead
of silently dropping the diagram.

Installed directly with:

```bash
dsh plugin --profile web add @puji4810/dsh-mermaid
```

or bundled with StudyOS — `dsh plugin --profile web add @puji4810/dsh-study`
activates the StudyOS panel plus both the TikZ and Mermaid renderers.