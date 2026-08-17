# @puji4810/dsh-tikz

Web client support for ` ```tikz ` fences. It serves the official TikZJax distribution and enables the `pgfplots` package plus `\pgfplotsset{compat=1.12}`, matching the TikZJax setup used by the Math vault. The host route also provides the pgfplots surf-shading filename aliases expected by TikZJax. Failed renders retain the source in an expandable diagnostic block instead of only showing TikZJax's `img-not-found` placeholder.
