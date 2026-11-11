# Style de l'interface

L'apparence de Fraud Rules est définie en un seul endroit. On fait évoluer l'application en réutilisant
l'existant, sans ajouter de styles propres à un écran. Ainsi, toutes les pages restent cohérentes.

## Où est quoi

| Fichier | Rôle |
| --- | --- |
| `src/styles/tokens.css` | **Les valeurs** : couleurs des thèmes clair et sombre, rouge de la marque, rayons, espacements (multiples de 4 px), tailles de texte, hauteurs de contrôle, ombres. Changer une valeur ici la change partout. |
| `src/styles/ui.css` | **Les classes communes**, construites uniquement avec les jetons `var(--…)`. Elles couvrent la base, les cartes, les boutons, les champs, les tableaux, la pagination, les badges, les alertes, les onglets, les indicateurs et les graphiques. On y trouve aussi les utilitaires, la coquille de l'application (barre latérale, barre supérieure), puis quelques styles propres à certaines pages. |
| `src/styles/index.css` | Point d'entrée : importe les deux fichiers, dans cet ordre. |
| `src/components/ui.tsx` | **Les composants React communs** : `Card`, `StatusBadge`, `CriticalityBadge`, `InfoTip`, `Alert`, `Spinner`… |
| `src/components/KpiTile.tsx`, `Pager.tsx`, `DailyBars.tsx` | Tuile d'indicateur, pagination des tableaux, histogramme journalier (remontées et fraudes confirmées superposées). |

## Règles

1. **Une section = une `Card`.** Elle porte un titre, une explication facultative (`subtitle`), une infobulle
   (`info`) et des actions à droite (`actions`). Avec `padded`, le contenu reçoit la marge standard. Sans
   `padded`, un tableau ou une liste va bord à bord et suit les coins arrondis.
   ```tsx
   <Card title="Historique des exécutions" info="Une ligne par exécution…" actions={<FiltreEchecs />}>
     <div className="table-wrap"><table className="data">…</table><Pager {...pager} /></div>
   </Card>
   ```
2. **Tableaux** : `table.data` dans un `.table-wrap`. La pagination passe par `usePaged(lignes, 'clé')` et
   `<Pager {...pager} />`. Les nombres vont dans des cellules `className="num"`.
3. **Chiffres clés** : `KpiTile`. Le premier chiffre d'une rangée peut être mis en avant avec `featured`.
4. **Pas de couleur en dur** (`#…`, `rgb(…)`) en dehors de `tokens.css`. Une nouvelle couleur devient un
   jeton, défini pour les deux thèmes.
5. **Pas de style inline statique** (`style={{ margin: 0 }}`, `style={{ color: 'var(--bad)' }}`). On utilise
   une classe commune ou un utilitaire :
   - texte : `text-good`, `text-bad`, `text-warn`, `strong`, `muted`, `small`, `ellipsis`, `break-word`,
     `text-right` ;
   - marges : `m-0`, `mt-1`, `mt-2`, `mt-6`, `mb-4` ;
   - espacements : `gap-1`, `gap-2`, `gap-3`, `gap-4`, avec `row`, `stack`, `nowrap-row`, `justify-end` ;
   - divers : `w-auto`, `select-sm`, `divider-bottom`, `fieldset-reset`, `scroll-box`.

   Un style inline n'est admis que pour une valeur **calculée**, par exemple la largeur d'une barre, la
   position d'une infobulle ou la couleur d'une version sur un graphique.
6. **Besoin d'un nouveau style** : on l'ajoute dans `ui.css`, à la bonne section, avec des jetons. On ne le
   met jamais dans le composant.

Les règles 4 et 5 sont vérifiées par `src/__tests__/style.test.ts` (`npm test`). Le test échoue en citant
le fichier et la ligne en cause.
