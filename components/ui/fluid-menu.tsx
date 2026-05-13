'use client'

import React, { useState } from 'react'

interface MenuItemProps {
  icon: React.ReactNode
  onClick?: () => void
}

export function MenuItem({ icon, onClick }: MenuItemProps) {
  return (
    <div
      onClick={onClick}
      style={{ width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: onClick ? 'pointer' : 'default' }}
    >
      {icon}
    </div>
  )
}

interface MenuContainerProps {
  children: React.ReactNode
}

export function MenuContainer({ children }: MenuContainerProps) {
  const [isExpanded, setIsExpanded] = useState(false)
  const childrenArray = React.Children.toArray(children)

  const toggle = () => setIsExpanded(p => !p)

  return (
    <div style={{ position: 'relative', width: 44 }} data-expanded={isExpanded}>
      {/* Trigger — always visible */}
      <div
        onClick={toggle}
        style={{
          position: 'relative',
          width: 44,
          height: 44,
          borderRadius: '50%',
          background: 'rgba(255,255,255,0.10)',
          border: '1px solid rgba(255,255,255,0.16)',
          backdropFilter: 'blur(10px)',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 50,
        }}
      >
        {childrenArray[0]}
      </div>

      {/* Expanded items */}
      {childrenArray.slice(1).map((child, index) => (
        <div
          key={index}
          onClick={() => setIsExpanded(false)}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: 44,
            height: 44,
            borderRadius: '50%',
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.13)',
            backdropFilter: 'blur(10px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 40 - index,
            transform: isExpanded ? `translateY(${(index + 1) * 52}px)` : 'translateY(0px)',
            opacity: isExpanded ? 1 : 0,
            pointerEvents: isExpanded ? 'all' : 'none',
            transition: `transform 280ms cubic-bezier(0.4, 0, 0.2, 1) ${index * 40}ms, opacity 240ms ease ${index * 30}ms`,
          }}
        >
          {child}
        </div>
      ))}
    </div>
  )
}
