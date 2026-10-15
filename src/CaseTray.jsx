import { Inbox } from 'lucide-react';

export function CaseTray({ cases, selectedId, onSelect }) {
  return <nav className="case-tray" aria-label="Incoming demo case tray">
    <div className="case-tray-heading">
      <span className="case-tray-title"><Inbox size={14} aria-hidden="true" />Case tray</span>
      <span className="case-tray-hint">Select a folder</span>
    </div>
    <div className="case-tray-folders">
      {cases.map(item => <button
        key={item.id}
        type="button"
        className={`case-tray-folder ${selectedId === item.id ? 'selected' : ''}`}
        aria-label={`Select ${item.caseId} — ${item.shortTitle} — ${item.status.label}`}
        aria-pressed={selectedId === item.id}
        onClick={() => onSelect(item.id)}
      >
        <img src="/assets/case-folder.png" alt="" draggable="false" />
        <span className="case-tray-case-id">{item.caseId}</span>
        <span className="case-tray-short-title">{item.shortTitle}</span>
        <span className={`case-tray-status ${item.status.tone || 'neutral'}`}>
          <span className="case-tray-status-dot" aria-hidden="true" /><span className="case-tray-status-label">{item.status.label}</span>
        </span>
      </button>)}
    </div>
  </nav>;
}
