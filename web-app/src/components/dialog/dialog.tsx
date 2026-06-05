import './dialog.sass'

export function Dialog() {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="dialog" role="dialog" aria-modal="true" />
    </div>
  )
}
