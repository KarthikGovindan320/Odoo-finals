# Brand assets

`logo-source.jpeg` is the master artwork. Everything the app serves is derived
from it and lives in `web/public/`, so regenerate rather than edit those by hand:

```bash
convert brand/logo-source.jpeg -fuzz 6% -trim +repage \
  -resize 512x512^ -gravity center -extent 512x512 /tmp/logo.png

for s in 256 180 64 32 16; do
  convert /tmp/logo.png -resize ${s}x${s} -strip PNG8:web/public/logo-${s}.png
done

convert web/public/logo-32.png web/public/logo-16.png web/public/favicon.ico
```

The trim matters: the source has a flat field around the tile, and without it the
mark floats inside its own padding at 26px. `PNG8` matters too — the artwork is
flat enough that a 32-colour palette is indistinguishable at these sizes and a
fraction of the weight.
