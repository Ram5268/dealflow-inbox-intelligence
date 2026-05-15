'use client'

import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'

interface Props {
  onDone?: () => void
}

export default function ChatShaderBg({ onDone }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer
    uniforms: { time: { value: number }; resolution: { value: THREE.Vector2 } }
    animationId: number
  } | null>(null)
  const [opacity, setOpacity] = useState(1)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const vertexShader = `
      void main() {
        gl_Position = vec4(position, 1.0);
      }
    `

    const fragmentShader = `
      precision highp float;
      uniform vec2 resolution;
      uniform float time;

      void main(void) {
        vec2 uv = (gl_FragCoord.xy * 2.0 - resolution.xy) / min(resolution.x, resolution.y);
        float t = time * 0.05;
        float lineWidth = 0.0018;

        float c0 = 0.0, c1 = 0.0, c2 = 0.0;
        for (int i = 0; i < 5; i++) {
          float fi = float(i);
          float base = fract(t + fi * 0.01) * 5.0 - length(uv) + mod(uv.x + uv.y, 0.2);
          c0 += lineWidth * fi * fi / abs(base - 0.00);
          c1 += lineWidth * fi * fi / abs(base - 0.01);
          c2 += lineWidth * fi * fi / abs(base - 0.02);
        }

        // Warm amber / terracotta palette
        vec3 amber = vec3(0.737, 0.471, 0.220);
        vec3 terra = vec3(0.627, 0.314, 0.157);
        vec3 cream = vec3(0.878, 0.753, 0.565);
        vec3 dark  = vec3(0.071, 0.027, 0.008);

        vec3 col = dark
          + amber * clamp(c0, 0.0, 1.4)
          + terra * clamp(c1, 0.0, 0.9)
          + cream * clamp(c2, 0.0, 0.5);

        gl_FragColor = vec4(col, 1.0);
      }
    `

    const camera = new THREE.Camera()
    camera.position.z = 1
    const scene = new THREE.Scene()
    const geometry = new THREE.PlaneGeometry(2, 2)
    const uniforms = {
      time:       { value: 1.0 },
      resolution: { value: new THREE.Vector2() },
    }
    const material = new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader })
    scene.add(new THREE.Mesh(geometry, material))

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    container.appendChild(renderer.domElement)

    const resize = () => {
      const w = container.clientWidth
      const h = container.clientHeight
      renderer.setSize(w, h)
      uniforms.resolution.value.set(renderer.domElement.width, renderer.domElement.height)
    }
    resize()
    window.addEventListener('resize', resize)

    let animationId = 0
    const animate = () => {
      animationId = requestAnimationFrame(animate)
      uniforms.time.value += 0.07
      renderer.render(scene, camera)
      if (sceneRef.current) sceneRef.current.animationId = animationId
    }
    sceneRef.current = { renderer, uniforms, animationId: 0 }
    animate()

    // Hold for 0.35s then fade out over 0.45s
    const fadeTimer = setTimeout(() => setOpacity(0), 350)
    const doneTimer = setTimeout(() => onDone?.(), 850)

    return () => {
      clearTimeout(fadeTimer)
      clearTimeout(doneTimer)
      window.removeEventListener('resize', resize)
      cancelAnimationFrame(animationId)
      if (container.contains(renderer.domElement)) container.removeChild(renderer.domElement)
      renderer.dispose()
      geometry.dispose()
      material.dispose()
    }
  }, [])

  return (
    <div
      ref={containerRef}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 10,
        opacity,
        transition: 'opacity 0.45s cubic-bezier(0.4, 0, 0.2, 1)',
        pointerEvents: 'none',
        mixBlendMode: 'screen',
      }}
    />
  )
}
