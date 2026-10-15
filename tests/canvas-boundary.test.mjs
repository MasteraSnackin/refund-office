import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';

const source = transformSync(readFileSync(new URL('../src/CanvasBoundary.jsx', import.meta.url), 'utf8'), {
  loader: 'jsx', format: 'cjs', jsxFactory: '__view.element',
}).code;
const module = { exports: {} };
class Component { constructor(props) { this.props = props; } }
runInNewContext(source, {
  module, exports: module.exports,
  require: name => { assert.equal(name, 'react'); return { Component }; },
  __view: { element: (type, props, ...children) => ({ type, props: { ...props, children } }) },
});
const { CanvasBoundary } = module.exports;
const text = tree => Array.isArray(tree) ? tree.map(text).join(' ') : tree && typeof tree === 'object' ? text(tree.props?.children) : typeof tree === 'string' ? tree : '';

test('the canvas boundary returns healthy children without changing the office', () => {
  const children = { marker: 'saved-record-view' };
  const boundary = new CanvasBoundary({ children });
  assert.equal(boundary.render(), children);
});

test('a canvas error offers a safe return without rendering failed content or error details', () => {
  let closed = 0;
  const boundary = new CanvasBoundary({ children: 'Failed canvas content', onClose: () => closed++ });
  boundary.state = CanvasBoundary.getDerivedStateFromError(new Error('PRIVATE_DIAGNOSTIC'));
  const view = boundary.render();
  assert.equal(view.props.role, 'alert');
  assert.match(text(view), /Case canvas unavailable/);
  assert.doesNotMatch(text(view), /Failed canvas content|PRIVATE_DIAGNOSTIC/);
  const close = view.props.children.find(child => child?.type === 'button');
  assert.equal(text(close), 'Back to office');
  close.props.onClick();
  assert.equal(closed, 1);
});
