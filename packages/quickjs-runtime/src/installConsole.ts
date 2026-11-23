// Copyright 2026 Parity Technologies (UK) Ltd.
// SPDX-License-Identifier: AGPL-3.0-only

import type { QuickJSContext } from 'quickjs-emscripten-core';

import { defineVmFunctions } from './defineVmFunctions.js';
import { getVmErrorMessage } from './getVmErrorMessage.js';

/** The console method the VM's code called. */
export type ConsoleLevel = 'debug' | 'log' | 'info' | 'warn' | 'error';

/** Hears one console call of the VM's code, as its level and the message its arguments format to. */
export type ConsoleSink = (level: ConsoleLevel, message: string) => void;

const CONSOLE_LEVELS: readonly ConsoleLevel[] = ['debug', 'log', 'info', 'warn', 'error'];

// A module that logs a huge string would otherwise hand all of it to the page's logger. Far above any readable use.
const MAX_MESSAGE_LENGTH = 64 * 1024;

// Every C0 control character but tab and line feed, so a message cannot drive a terminal that shows it, such as by an
// escape sequence or a carriage return.
// eslint-disable-next-line no-control-regex -- matching control characters is the point
const CONTROL_CHARACTERS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** Sets the VM's `console`, whose calls reach `onConsole` and are never logged here. */
export function installConsole(vm: QuickJSContext, onConsole: ConsoleSink): void {
  const vmConsole = vm.newObject();
  defineVmFunctions(
    vm,
    vmConsole,
    Object.fromEntries(
      CONSOLE_LEVELS.map(level => [
        level,
        (...args) => {
          onConsole(level, formatMessage(args.map((arg): unknown => vm.dump(arg))));
        },
      ]),
    ),
  );
  vm.setProp(vm.global, 'console', vmConsole);
  vmConsole.dispose();
}

/** The arguments as one line, after the format directives of a first string argument, as a browser console prints. */
function formatMessage(args: unknown[]): string {
  if (args.length === 0) {
    return '';
  }
  const [first, ...rest] = args;
  let next = 0;
  const lead =
    typeof first === 'string'
      ? first.replace(/%[sdifoOc%]/g, directive => {
          if (directive === '%%') {
            return '%';
          }
          if (next >= rest.length) {
            return directive;
          }
          const value = rest[next];
          next += 1;
          return formatDirective(directive, value);
        })
      : stringify(first);
  const message = [lead, ...rest.slice(next).map(stringify)].join(' ').replace(CONTROL_CHARACTERS, '�');
  return message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]` : message;
}

function formatDirective(directive: string, value: unknown): string {
  switch (directive) {
    case '%d':
    case '%i': {
      const number = Number(value);
      return Number.isFinite(number) ? String(Math.trunc(number)) : 'NaN';
    }
    case '%f':
      return String(Number(value));
    // Styling has no meaning outside a browser console.
    case '%c':
      return '';
    default:
      return stringify(value);
  }
}

function stringify(value: unknown): string {
  return typeof value === 'string' ? value : getVmErrorMessage(value);
}
