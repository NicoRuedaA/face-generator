from pathlib import Path

import numpy as np
import plotly.graph_objects as go

archive = np.load("work/heads-test.npz", allow_pickle=False)
vertices = archive["template"]
triangles = archive["triangles"].astype(int)
vertex_ids = np.arange(len(vertices))

figure = go.Figure()

figure.add_trace(
    go.Mesh3d(
        x=vertices[:, 0],
        y=vertices[:, 1],
        z=vertices[:, 2],
        i=triangles[:, 0],
        j=triangles[:, 1],
        k=triangles[:, 2],
        opacity=0.25,
        hoverinfo="skip",
        name="Malla",
    )
)

figure.add_trace(
    go.Scatter3d(
        x=vertices[:, 0],
        y=vertices[:, 1],
        z=vertices[:, 2],
        mode="markers",
        marker={"size": 1.8},
        customdata=vertex_ids,
        hovertemplate=(
            "<b>Vértice %{customdata}</b><br>"
            "x=%{x:.5f}<br>"
            "y=%{y:.5f}<br>"
            "z=%{z:.5f}"
            "<extra></extra>"
        ),
        name="Vértices",
    )
)

figure.update_layout(
    title="GNM Head — selecciona vértices anatómicos",
    scene={
        "aspectmode": "data",
        "xaxis_title": "X",
        "yaxis_title": "Y",
        "zaxis_title": "Z",
    },
    margin={"l": 0, "r": 0, "t": 50, "b": 0},
)

plot = figure.to_html(
    full_html=False,
    include_plotlyjs=True,
    div_id="gnm-viewer",
)

html = f"""<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<title>GNM Vertex Viewer</title>
<style>
body {{
    margin: 0;
    font-family: sans-serif;
    background: #111;
    color: #eee;
}}
#instructions {{
    padding: 12px 18px;
}}
#selected {{
    margin: 0 18px 18px;
    padding: 12px;
    min-height: 50px;
    white-space: pre-wrap;
    background: #222;
    border: 1px solid #555;
}}
</style>
</head>
<body>
<div id="instructions">
    Arrastra para rotar, usa la rueda para acercar y pulsa un punto para guardar
    su número. Recarga la página para limpiar la selección.
</div>

<div id="selected">Vértices seleccionados:</div>

{plot}

<script>
const viewer = document.getElementById("gnm-viewer");
const selected = document.getElementById("selected");

viewer.on("plotly_click", function(event) {{
    const point = event.points[0];

    if (point.customdata === undefined) {{
        return;
    }}

    selected.textContent += "\\n" +
        point.customdata +
        "  [" +
        point.x.toFixed(5) + ", " +
        point.y.toFixed(5) + ", " +
        point.z.toFixed(5) + "]";
}});
</script>
</body>
</html>
"""

output = Path("work/gnm-vertex-viewer.html")
output.write_text(html, encoding="utf-8")

print(f"Visor creado: {output}")
