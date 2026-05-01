(function () {
    // Canvas display size = glyph size × SCALE. The factor leaves a little
    // breathing room around the dome (was originally for the swirl trail).
    const SCALE = 2.6;
    // Internal pixel buffer is supersampled for sharpness.
    const SUPERSAMPLE = 2;

    const vs = `attribute vec2 a_position; varying vec2 v_uv; void main() { v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;

    const fs = `
        precision mediump float;
        varying vec2 v_uv;
        uniform float u_rad;

        const float REPS = 3.0;
        const float TIME = 0.0;

        void main() {
            vec2 delta = v_uv - vec2(0.5);
            float dist = length(delta);
            float angle = atan(delta.y, delta.x);

            float phase = angle * REPS + pow(dist, 0.8) * 20.0 - TIME;

            vec3 c1 = vec3(0.99, 0.96, 0.90);
            vec3 c2 = vec3(0.96, 0.33, 0.48);
            vec3 c3 = vec3(0.16, 0.71, 0.96);

            float w1 = pow(max(0.0, cos(phase)), 12.0);
            float w2 = pow(max(0.0, cos(phase - 2.0944)), 12.0);
            float w3 = pow(max(0.0, cos(phase - 4.1888)), 12.0);
            vec3 col = (w1*c1 + w2*c2 + w3*c3) / max(w1 + w2 + w3, 0.0001);

            if (dist < u_rad) {
                vec3 n = normalize(vec3(delta.x, delta.y, sqrt(max(0.0, u_rad*u_rad - dist*dist)) * 0.9));
                col *= (0.7 + 0.3 * max(dot(n, normalize(vec3(-1, 1, 1))), 0.0));
                float spec = max(dot(vec3(0,0,1), reflect(-normalize(vec3(-1.5, 1.5, 0.3)), n)), 0.0);
                col += vec3(1.0) * (smoothstep(0.85, 0.95, spec)*0.7 + pow(spec, 60.0)*0.5);
                col += col * pow(1.0 - n.z, 3.0) * 0.5;
                col = mix(col, vec3(0.05), smoothstep(u_rad - 0.015, u_rad, dist) * 0.5);
            }

            float alpha = smoothstep(u_rad, u_rad - 0.005, dist);
            gl_FragColor = vec4(col, alpha);
        }
    `;

    function compileShader(gl, type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        return s;
    }

    function createProgram(gl, vsSrc, fsSrc) {
        const p = gl.createProgram();
        gl.attachShader(p, compileShader(gl, gl.VERTEX_SHADER, vsSrc));
        gl.attachShader(p, compileShader(gl, gl.FRAGMENT_SHADER, fsSrc));
        gl.linkProgram(p);
        return p;
    }

    // Renders the spiral into a canvas. The dome occupies a circle of
    // `radius` (in normalized 0..0.5 coords).
    function renderSpiral(canvas, radius) {
        const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
        if (!gl) return false;
        const prog = createProgram(gl, vs, fs);
        gl.useProgram(prog);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        const posLoc = gl.getAttribLocation(prog, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
        gl.uniform1f(gl.getUniformLocation(prog, 'u_rad'), radius);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        return true;
    }

    async function initVortex(container) {
        const anchor = container.querySelector('.vortex-anchor');
        if (!anchor) return;

        if (document.fonts && document.fonts.ready) {
            await document.fonts.ready;
        }

        const textNode = Array.from(anchor.childNodes).find(
            (n) => n.nodeType === Node.TEXT_NODE && n.textContent.trim()
        );
        if (!textNode) return;

        const range = document.createRange();
        range.selectNodeContents(textNode);
        const glyphRect = range.getBoundingClientRect();
        const anchorRect = anchor.getBoundingClientRect();
        if (glyphRect.width === 0) return;

        const baseSize = glyphRect.width;
        const displaySize = baseSize * SCALE;
        const pxSize = Math.round(displaySize * SUPERSAMPLE);
        const radius = (baseSize / 2) / displaySize;

        // Center the canvas on the actual glyph, not the anchor box
        // (the anchor's vertical center can sit above the lowercase glyph).
        const offsetX = (glyphRect.left + glyphRect.right - anchorRect.left - anchorRect.right) / 2;
        const offsetY = (glyphRect.top + glyphRect.bottom - anchorRect.top - anchorRect.bottom) / 2;

        const canvas = document.createElement('canvas');
        canvas.width = pxSize;
        canvas.height = pxSize;
        Object.assign(canvas.style, {
            position: 'absolute',
            width: displaySize + 'px',
            height: displaySize + 'px',
            left: `calc(50% + ${offsetX}px)`,
            top: `calc(50% + ${offsetY}px)`,
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
        });
        anchor.appendChild(canvas);

        renderSpiral(canvas, radius);
    }

    // Math mirrors the fragment shader: phase = angle*REPS + dist^0.8 * 20.
    // We trace 9 fixed-color bands (REPS=3 cycles × 3 colours) as filled
    // SVG paths between two phase-const spirals each. The dome shading is
    // approximated with two radial gradients (highlight + edge darkening).
    function generateSVG(size = 512) {
        const REPS = 3;
        const DOME_NORM = 0.45;
        const cx = size / 2;
        const cy = size / 2;
        const domePx = DOME_NORM * size;

        const colors = ['#fcf5e6', '#f5547a', '#29b5f5'];
        const bandsPerCycle = 3;
        const total = REPS * bandsPerCycle;
        const phaseStep = (2 * Math.PI) / bandsPerCycle;
        const half = phaseStep / 2;
        const samples = 80;

        // Extend the bands a bit past the dome so the circular clipPath
        // produces a clean curved outer edge instead of a polygon of chords.
        const OVERSCAN = 1.08;
        const ptOnSpiral = (centerPhase, edgeSign, i) => {
            const rN = (i / samples) * DOME_NORM * OVERSCAN;
            const angle = (centerPhase + edgeSign * half - Math.pow(rN, 0.8) * 20) / REPS;
            const x = cx + rN * size * Math.cos(angle);
            const y = cy + rN * size * Math.sin(angle);
            return `${x.toFixed(2)} ${y.toFixed(2)}`;
        };

        let paths = '';
        for (let b = 0; b < total; b++) {
            const cp = b * phaseStep;
            let d = `M ${cx} ${cy}`;
            for (let i = 1; i <= samples; i++) d += ` L ${ptOnSpiral(cp, +1, i)}`;
            for (let i = samples; i >= 0; i--) d += ` L ${ptOnSpiral(cp, -1, i)}`;
            d += ' Z';
            paths += `<path d="${d}" fill="${colors[b % bandsPerCycle]}"/>`;
        }

        return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">
<defs>
<clipPath id="sp-dome"><circle cx="${cx}" cy="${cy}" r="${domePx}"/></clipPath>
<radialGradient id="sp-light" cx="35%" cy="30%" r="70%">
<stop offset="0%" stop-color="white" stop-opacity="0.45"/>
<stop offset="55%" stop-color="white" stop-opacity="0"/>
</radialGradient>
<radialGradient id="sp-edge" cx="50%" cy="50%" r="50%">
<stop offset="82%" stop-color="black" stop-opacity="0"/>
<stop offset="100%" stop-color="black" stop-opacity="0.5"/>
</radialGradient>
</defs>
<g clip-path="url(#sp-dome)">
${paths}
<circle cx="${cx}" cy="${cy}" r="${domePx}" fill="url(#sp-edge)"/>
<circle cx="${cx}" cy="${cy}" r="${domePx}" fill="url(#sp-light)"/>
</g>
</svg>`;
    }

    function downloadSVG(filename = 'schema-pop.svg', size = 512) {
        const blob = new Blob([generateSVG(size)], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    }

    function downloadSpiral(filename = 'schema-pop.png', size = 512) {
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        // 0.45 leaves ~5% padding on each side so the AA edge isn't clipped.
        if (!renderSpiral(canvas, 0.45)) return;
        canvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        }, 'image/png');
    }

    window.SchemaPopLogo = { init: initVortex, downloadSpiral, generateSVG, downloadSVG };

    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.schema-pop-logo').forEach(initVortex);
    });
})();
