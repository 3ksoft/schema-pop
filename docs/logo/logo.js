(function() {
    const CONFIG = { repetitions: 1.0, radius: 0.185, speed: 4.0 };

    const vs = `attribute vec2 a_position; varying vec2 v_texCoord; void main() { v_texCoord = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;
    const fs = `
        precision mediump float;
        varying vec2 v_texCoord;
        uniform float u_time, u_reps, u_rad, u_speed;
        uniform sampler2D u_buffer;
        void main() {
            vec2 uv = v_texCoord;
            vec2 center = vec2(0.5);
            vec2 delta = uv - center;
            float dist = length(delta);
            float angle = atan(delta.y, delta.x);

            // Feedback / Vortex
            vec2 readUV = center + vec2(cos(angle - 0.04/(dist+0.1)), sin(angle - 0.04/(dist+0.1))) * (dist + 0.006);
            vec4 prev = texture2D(u_buffer, readUV) * 0.97;
            if(prev.a < 0.01) prev = vec4(0.0);

            // Lollipop
            float mask = smoothstep(u_rad, u_rad - 0.005, dist);
            float phase = angle * u_reps + pow(dist, 0.8) * 20.0 - u_time * u_speed;
            
            vec3 c1 = vec3(0.99, 0.96, 0.90); // Cream
            vec3 c2 = vec3(0.96, 0.33, 0.48); // Pink
            vec3 c3 = vec3(0.16, 0.71, 0.96); // Blue
            
            float w1 = pow(max(0.0, cos(phase)), 12.0);
            float w2 = pow(max(0.0, cos(phase - 2.0944)), 12.0);
            float w3 = pow(max(0.0, cos(phase - 4.1888)), 12.0);
            vec3 lolli = (w1*c1 + w2*c2 + w3*c3) / (w1 + w2 + w3);

            // Light
            if (dist < u_rad) {
                vec3 n = normalize(vec3(delta.x, delta.y, sqrt(max(0.0, u_rad*u_rad - dist*dist)) * 0.9));
                lolli *= (0.7 + 0.3 * max(dot(n, normalize(vec3(-1, 1, 1))), 0.0));
                float spec = max(dot(vec3(0,0,1), reflect(-normalize(vec3(-1.5, 1.5, 0.3)), n)), 0.0);
                lolli += vec3(1.0) * (smoothstep(0.85, 0.95, spec)*0.7 + pow(spec, 60.0)*0.5);
                lolli += lolli * pow(1.0 - n.z, 3.0) * 0.5;
            }
            lolli = mix(lolli, vec3(0.05), smoothstep(u_rad - 0.015, u_rad, dist) * 0.5);
            gl_FragColor = mix(prev, vec4(lolli, 1.0), mask);
        }
    `;

    const displayFs = `precision mediump float; varying vec2 v_texCoord; uniform sampler2D u_tex; void main() { gl_FragColor = texture2D(u_tex, v_texCoord); }`;

    function initVortex(container) {
        const anchor = container.querySelector('.vortex-anchor');
        const size = container.classList.contains('size-512') ? 512 : container.classList.contains('size-256') ? 256 : 128;
        
        const canvas = document.createElement('canvas');
        canvas.width = size * 2; // Supersampling for sharpness
        canvas.height = size * 2;
        anchor.appendChild(canvas);

        const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false });
        if (!gl) return;

        const createProg = (fss) => {
            const p = gl.createProgram();
            const s1 = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(s1, vs); gl.compileShader(s1);
            const s2 = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(s2, fss); gl.compileShader(s2);
            gl.attachShader(p, s1); gl.attachShader(p, s2); gl.linkProgram(p);
            return p;
        };

        const vProg = createProg(fs);
        const dProg = createProg(displayFs);
        const posBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

        const createFBO = () => {
            const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, canvas.width, canvas.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
            gl.texParameteri(gl.TEXTURE_2D, 10242, 33071); gl.texParameteri(gl.TEXTURE_2D, 10243, 33071);
            gl.texParameteri(gl.TEXTURE_2D, 10241, 9729); gl.texParameteri(gl.TEXTURE_2D, 10240, 9729);
            const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, 36064, gl.TEXTURE_2D, t, 0);
            return { f, t };
        };

        let fA = createFBO(), fB = createFBO();
        const u = { 
            t: gl.getUniformLocation(vProg, "u_time"), b: gl.getUniformLocation(vProg, "u_buffer"),
            r: gl.getUniformLocation(vProg, "u_reps"), rad: gl.getUniformLocation(vProg, "u_rad"), s: gl.getUniformLocation(vProg, "u_speed")
        };

        let start = performance.now();
        function loop() {
            let time = (performance.now() - start) / 1000;
            gl.useProgram(vProg); gl.bindFramebuffer(gl.FRAMEBUFFER, fB.f); gl.viewport(0,0,canvas.width,canvas.height);
            gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
            gl.uniform1f(u.t, time); gl.uniform1f(u.r, CONFIG.repetitions); gl.uniform1f(u.rad, CONFIG.radius); gl.uniform1f(u.s, CONFIG.speed);
            gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fA.t); gl.uniform1i(u.b, 0);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

            gl.useProgram(dProg); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.clear(16384);
            gl.bindTexture(gl.TEXTURE_2D, fB.t); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
            [fA, fB] = [fB, fA];
            requestAnimationFrame(loop);
        }
        loop();
    }

    // Auto-init all logos on the page
    document.addEventListener('DOMContentLoaded', () => {
        document.querySelectorAll('.schema-pop-logo').forEach(initVortex);
    });
})();