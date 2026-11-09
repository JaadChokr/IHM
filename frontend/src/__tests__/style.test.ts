import { describe, expect, it } from 'vitest';

/**
 * Garde-fous de l'uniformité du style (voir frontend/STYLE.md) : les valeurs de l'interface vivent dans
 * styles/tokens.css, l'apparence dans les classes communes. Ces tests échouent si un écran s'en écarte.
 */
const css = import.meta.glob('../**/*.css', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const tsx = import.meta.glob(['../**/*.tsx', '!../**/__tests__/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

const COLOR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const lines = (src: string) => src.split('\n').map((text, i) => ({ text, n: i + 1 }));

describe('style centralisé', () => {
  it('aucune couleur en dur hors de styles/tokens.css', () => {
    const offenders = Object.entries({ ...css, ...tsx })
      .filter(([file]) => !file.endsWith('styles/tokens.css'))
      .flatMap(([file, src]) =>
        lines(src)
          .filter(({ text }) => COLOR.test(text.replace(/\/\*.*?\*\/|\/\/.*$/g, '')))
          .map(({ text, n }) => `${file}:${n}  ${text.trim()}`),
      );
    expect(offenders).toEqual([]);
  });

  it('pas de style inline statique dans les composants (utiliser les classes communes)', () => {
    // Autorisé : une valeur calculée (largeur d'une barre, position d'une infobulle, couleur d'une version).
    // Interdit : une valeur littérale (margin: 0, color: 'var(--bad)'…) : elle a sa classe dans ui.css.
    const offenders = Object.entries(tsx).flatMap(([file, src]) =>
      [...src.matchAll(/style=\{\{([^{}]*)\}\}/g)]
        .filter(([, body]) =>
          body.split(/,(?![^()]*\))/).some((prop) => {
            const value = prop.split(':').slice(1).join(':').trim();
            return /^(-?\d+(\.\d+)?|'[^'$]*'|"[^"$]*")$/.test(value);
          }),
        )
        .map(([m]) => `${file}  ${m}`),
    );
    expect(offenders).toEqual([]);
  });
});
