// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

// The mood ring drawn around a profile avatar.
//
// One WebGL program, a few numbers per mood: three colours, a tempo and a
// turbulence, scaled by intensity and faded by age. Ported from Seity's mood
// ring mockup; the palette is the standard six moods by three intensities.
// Without WebGL it falls back to a static conic gradient, and under
// prefers-reduced-motion it draws one still frame.

import type { Mood, MoodIntensity, MoodKind } from "./profile-record";

interface Palette {
  readonly label: string;
  readonly a: string;
  readonly b: string;
  readonly c: string;
  readonly speed: number;
  readonly turb: number;
}

export const MOOD_PALETTE: Record<MoodKind, Palette> = {
  calm: { label: "Calm", a: "#2dd4bf", b: "#38bdf8", c: "#0e7490", speed: 0.25, turb: 0.3 },
  focused: { label: "Focused", a: "#8b5cf6", b: "#c4b5fd", c: "#4338ca", speed: 0.4, turb: 0.15 },
  hyped: { label: "Hyped", a: "#e6007a", b: "#ff8a3d", c: "#ffd166", speed: 1.3, turb: 0.9 },
  social: { label: "Social", a: "#fbbf24", b: "#fde68a", c: "#ea580c", speed: 0.8, turb: 0.5 },
  "low-key": { label: "Low-key", a: "#b48ead", b: "#6b4d78", c: "#3b2a4a", speed: 0.2, turb: 0.2 },
  away: { label: "Away", a: "#8c8f98", b: "#dadbe0", c: "#404249", speed: 0.08, turb: 0.05 },
};

export const INTENSITY: Record<MoodIntensity, { label: string; k: number }> = {
  soft: { label: "Soft", k: 0.55 },
  steady: { label: "Steady", k: 1 },
  loud: { label: "Loud", k: 1.8 },
};

const VS = `attribute vec2 a_pos;varying vec2 v_uv;
void main(){v_uv=a_pos;gl_Position=vec4(a_pos,0.0,1.0);}`;

const FS = `precision highp float;varying vec2 v_uv;
uniform float u_time,u_speed,u_turb,u_age,u_inner,u_width,u_half,u_bright,u_halo;uniform vec3 u_a,u_b,u_c;
float hash(vec2 p){p=fract(p*vec2(123.34,456.21));p+=dot(p,p+45.32);return fract(p.x*p.y);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);float a=hash(i),b=hash(i+vec2(1,0)),c=hash(i+vec2(0,1)),d=hash(i+vec2(1,1));return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}
vec3 ramp(float x){float f=x*3.0;if(f<1.0)return mix(u_a,u_b,f);if(f<2.0)return mix(u_b,u_c,f-1.0);return mix(u_c,u_a,f-2.0);}
void main(){
  float r=length(v_uv);float ang=atan(v_uv.y,v_uv.x);float t=u_time*u_speed;
  vec2 onCircle=vec2(cos(ang),sin(ang));
  float n=fbm(onCircle*(1.6+u_turb*1.4)+vec2(t*0.45,-t*0.3));
  float n2=fbm(onCircle*3.0-vec2(t*0.2,t*0.35)+7.0);
  float w=u_width*(0.78+0.44*n)*mix(1.0,0.72,u_age);
  float aa=1.5/u_half;
  float r0=u_inner,r1=u_inner+w;
  float band=smoothstep(r0-aa,r0+aa,r)*(1.0-smoothstep(r1-aa,r1+aa,r));
  float flow=fract(ang/6.2831853+t*0.12+(n2-0.5)*u_turb*0.6);
  vec3 col=ramp(flow)*u_bright;
  float d=max(0.0,r-r1);float outside=smoothstep(r1-aa,r1+aa,r);
  float glow=outside*exp(-d*d*u_half*u_half*(0.05/max(u_halo,0.3)))*(0.14+0.2*u_halo+0.15*n);
  float fade=mix(1.0,0.38,u_age);
  float alpha=clamp(band+glow*(1.0-band),0.0,1.0)*fade*smoothstep(u_inner-2.0*aa,u_inner,r);
  gl_FragColor=vec4(col*alpha,alpha);
}`;

function rgb(hex: string): [number, number, number] {
  return [
    Number.parseInt(hex.slice(1, 3), 16) / 255,
    Number.parseInt(hex.slice(3, 5), 16) / 255,
    Number.parseInt(hex.slice(5, 7), 16) / 255,
  ];
}

/** How far through its life the mood is, 0 (just set) to 1 (about to lapse). */
export function moodAge(mood: Mood, nowSecs = Date.now() / 1000): number {
  if (mood.ttlSecs <= 0) {
    return 0;
  }
  return Math.min(1, Math.max(0, (nowSecs - mood.setAt) / mood.ttlSecs));
}

export interface MoodRingHandle {
  readonly element: HTMLElement;
  stop(): void;
}

/**
 * A ring layer sized to wrap an avatar of `avatarPx`. Place the returned
 * element centred over the avatar; it paints nothing over the avatar itself.
 */
export function createMoodRing(mood: Mood, avatarPx: number): MoodRingHandle {
  const palette = MOOD_PALETTE[mood.kind];
  const k = INTENSITY[mood.intensity].k;
  const age = moodAge(mood);
  const size = Math.round(avatarPx * 1.5);

  const element = document.createElement("div");
  element.className = "profile-mood-ring";
  element.style.width = `${String(size)}px`;
  element.style.height = `${String(size)}px`;
  element.setAttribute("aria-hidden", "true");

  const fallback = (): MoodRingHandle => {
    element.classList.add("profile-mood-ring-static");
    element.style.setProperty("--ring-a", palette.a);
    element.style.setProperty("--ring-b", palette.b);
    element.style.setProperty("--ring-c", palette.c);
    element.style.opacity = String(1 - 0.62 * age);
    return { element, stop: () => undefined };
  };

  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
  if (gl === null) {
    return fallback();
  }
  const compile = (type: number, source: string): WebGLShader | null => {
    const shader = gl.createShader(type);
    if (shader === null) {
      return null;
    }
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    return shader;
  };
  const vs = compile(gl.VERTEX_SHADER, VS);
  const fs = compile(gl.FRAGMENT_SHADER, FS);
  const program = gl.createProgram();
  if (vs === null || fs === null) {
    return fallback();
  }
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  if (!(gl.getProgramParameter(program, gl.LINK_STATUS) as boolean)) {
    return fallback();
  }
  gl.useProgram(program);

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(size * dpr);
  canvas.height = Math.round(size * dpr);
  element.appendChild(canvas);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
    gl.STATIC_DRAW,
  );
  const position = gl.getAttribLocation(program, "a_pos");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.viewport(0, 0, canvas.width, canvas.height);

  const u = (name: string): WebGLUniformLocation | null =>
    gl.getUniformLocation(program, name);
  const half = (size / 2) * dpr;
  const widthPx = Math.max(3, Math.min(6, avatarPx * 0.05)) * (0.7 + 0.32 * k) * dpr;
  gl.uniform1f(u("u_half"), half);
  gl.uniform1f(u("u_inner"), ((avatarPx / 2 + 3) * dpr) / half);
  gl.uniform1f(u("u_width"), widthPx / half);
  gl.uniform1f(u("u_speed"), palette.speed * k);
  gl.uniform1f(u("u_turb"), Math.min(1, palette.turb * k));
  gl.uniform1f(u("u_bright"), 0.62 + 0.36 * k);
  gl.uniform1f(u("u_halo"), k);
  gl.uniform1f(u("u_age"), age);
  gl.uniform3f(u("u_a"), ...rgb(palette.a));
  gl.uniform3f(u("u_b"), ...rgb(palette.b));
  gl.uniform3f(u("u_c"), ...rgb(palette.c));
  const timeUniform = u("u_time");

  const draw = (ms: number): void => {
    gl.uniform1f(timeUniform, ms / 1000);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  };

  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let frame = 0;
  let stopped = false;
  const loop = (ms: number): void => {
    if (stopped) {
      return;
    }
    draw(ms);
    frame = requestAnimationFrame(loop);
  };
  if (still) {
    draw(0);
  } else {
    frame = requestAnimationFrame(loop);
  }

  return {
    element,
    stop(): void {
      stopped = true;
      cancelAnimationFrame(frame);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    },
  };
}
