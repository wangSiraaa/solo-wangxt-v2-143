import React from 'react'

export function NumberField(props: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  unit?: string
  onChange: (v: number) => void
  hint?: string
}) {
  const { label, value, step = 0.1, min, max, unit, onChange, hint } = props
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {unit ? <em className="unit">{unit}</em> : null}
      </span>
      <input
        type="number"
        value={Number.isFinite(value) ? round(value) : ''}
        step={step}
        min={min}
        max={max}
        onChange={(e) => {
          const v = parseFloat(e.target.value)
          if (Number.isFinite(v)) onChange(v)
        }}
      />
      {hint ? <small className="field-hint">{hint}</small> : null}
    </label>
  )
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

export function SliderRow(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  unit?: string
  onChange: (v: number) => void
}) {
  return (
    <label className="field">
      <span className="field-label">
        {props.label}
        <em className="unit">
          {round(props.value)}
          {props.unit ?? ''}
        </em>
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(e) => props.onChange(parseFloat(e.target.value))}
      />
    </label>
  )
}

export function Panel(props: { title: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{props.title}</h2>
        {props.right}
      </header>
      <div className="panel-body">{props.children}</div>
    </section>
  )
}
