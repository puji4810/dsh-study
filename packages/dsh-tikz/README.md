# @puji4810/dsh-tikz

Web client support for ` ```tikz ` fences. It serves the official TikZJax distribution and enables the `pgfplots` package plus `\pgfplotsset{compat=1.12}`, matching the TikZJax setup used by the Math vault. The host route provides the pgfplots surf-shading filename alias expected by TikZJax while preserving PGFPlots' own fallback when the Ximera driver is unavailable. Failed renders retain the source in an expandable diagnostic block instead of only showing TikZJax's `img-not-found` placeholder.
