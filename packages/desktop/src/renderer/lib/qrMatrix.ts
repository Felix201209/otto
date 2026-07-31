/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import * as qrcodeTerminal from 'qrcode-terminal';

const ANSI_ESCAPE = String.fromCharCode(27);

/** Generates a QR matrix locally, without disclosing the payload to a third party. */
export function createQrMatrix(value: string): boolean[][] | null {
  try {
    let ansi: string | undefined;
    qrcodeTerminal.generate(value, { small: false }, (result) => {
      ansi = result;
    });
    if (!ansi) return null;

    const blackCell = `${ANSI_ESCAPE}[40m  ${ANSI_ESCAPE}[0m`;
    const whiteCell = `${ANSI_ESCAPE}[47m  ${ANSI_ESCAPE}[0m`;
    const rows = ansi
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const cells: boolean[] = [];
        let offset = 0;
        while (offset < line.length) {
          if (line.startsWith(blackCell, offset)) {
            cells.push(true);
            offset += blackCell.length;
          } else if (line.startsWith(whiteCell, offset)) {
            cells.push(false);
            offset += whiteCell.length;
          } else {
            offset += 1;
          }
        }
        return cells;
      })
      .filter((row) => row.length > 0);
    const width = rows[0]?.length ?? 0;
    if (
      width < 21 ||
      rows.length !== width ||
      rows.some((row) => row.length !== width)
    ) {
      return null;
    }
    return rows;
  } catch {
    return null;
  }
}
