import { Component } from 'react';

export class CanvasBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="case-canvas-loading" role="alert">
      <h2>Case canvas unavailable</h2>
      <p>The canvas could not be opened. Your saved case records are unchanged.</p>
      <p>You can return to the office and continue your work.</p>
      <button type="button" onClick={this.props.onClose}>Back to office</button>
    </section>;
  }
}
