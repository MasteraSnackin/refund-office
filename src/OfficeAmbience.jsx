const COFFEE_CUPS = [
  { id: 'policy', x: 59.4, y: 35.3, delay: '-1.8s' },
  { id: 'evidence', x: 36.8, y: 60.5, delay: '-4.9s' },
];

const SCREENS = [
  { id: 'evidence', x: 32.6, y: 24.1, delay: '-3s' },
  { id: 'policy', x: 54.65, y: 25.1, delay: '-7.5s' },
  { id: 'archive', x: 88.3, y: 26, delay: '-11s' },
];

// These details belong to the illustration; they never signal a case outcome.
export function OfficeAmbience({ phase }) {
  return <div className={`office-ambience ${phase === 'running' ? 'ambience-working' : ''}`} aria-hidden="true">
    {COFFEE_CUPS.map(cup => <span key={cup.id} className="office-coffee"
      style={{ left: `${cup.x}%`, top: `${cup.y}%`, '--ambience-delay': cup.delay }}>
      <span className="coffee-saucer" />
      <span className="coffee-cup" />
      <span className="coffee-steam"><i /><i /><i /></span>
    </span>)}
    <span className="office-printer-feed">
      <span className="printer-sheet"><i /><i /><i /></span>
      <span className="printer-slot" />
    </span>
    {SCREENS.map(screen => <span key={screen.id} className="office-screen-copy"
      style={{ left: `${screen.x}%`, top: `${screen.y}%`, '--ambience-delay': screen.delay }}>
      <span className="screen-text-lines"><i /><i /><i /><i /><i /><i /></span>
    </span>)}
  </div>;
}
