"""Show coverage gains and a blurred-edge failure with a shared error scale."""
from pathlib import Path
import runpy
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
E = runpy.run_path(str(ROOT/'scripts/experiment-fringe-coverage-budget.py'))


def main():
    cases = {c['name']: c for suite in ('matrix', 'challenge') for c in E['E']['fixtures'](suite)}
    examples = [('narrow-roll-17.4', 'Rolled edge'), ('noisy-hole-flat', 'Noisy flat with hole'),
                ('precise-weak-rim', 'Fading fringe contrast'), ('challenge-blur-56', 'Blur: remaining failure')]
    fig, axes = plt.subplots(4, 3, figsize=(11, 13), layout='constrained')
    cmap = plt.get_cmap('coolwarm').copy(); cmap.set_bad('#303844')
    for i, (name, title) in enumerate(examples):
        case = cases[name]
        rows, outputs, source = E['run_case'](case, rim_audit=True)
        records = {r['method']: r for r in rows}
        axes[i, 0].imshow(case['image'], cmap='gray', vmin=0, vmax=255)
        axes[i, 0].set_title(title); axes[i, 0].set_xlabel(name, fontsize=9)
        y, x = np.indices(case['image'].shape); base = source['valid']
        design = np.column_stack([np.ones(base.sum()), x[base], y[base]])
        theta = source['metadata']['carrier_angle_rad']
        scale = np.sign(np.cos(theta)*case['fx']+np.sin(theta)*case['fy'])*E['NM_PER_RAD']
        for j, (method, label) in enumerate([('hybrid', 'Existing Hybrid'), ('selected-5nm', 'Coverage-first candidate')], 1):
            output = outputs[method]; error = output['phase']*scale-case['truth']
            coeff = np.linalg.lstsq(design, error[base], rcond=None)[0]
            error -= coeff[0]+coeff[1]*x+coeff[2]*y
            shown = axes[i, j].imshow(np.ma.array(error, mask=~output['valid']), cmap=cmap, vmin=-20, vmax=20)
            axes[i, j].contour(case['physical'], [.5], colors=['#e7e7e7'], linewidths=.5)
            r = records[method]
            axes[i, j].set_title(f'{label}\nArea {r["physical_coverage_pct"]:.1f}% | edge {r["edge_coverage_pct"]:.1f}%', fontsize=10)
            value = r['added_anchor_max_nm']
            axes[i, j].set_xlabel('Original measurements' if value is None else f'Maximum added-area error: {value:.2f} nm', fontsize=9)
        for ax in axes[i]: ax.set_xticks([]); ax.set_yticks([])
    fig.colorbar(shown, ax=axes[:, 1:], shrink=.7, extend='both', label='Height error (nm; saturates at ±20)')
    fig.suptitle('Recovering the edge from recorded fringes\nDark gray = unmeasured; white line = physical aperture; reference plane uses original Hybrid anchors', fontsize=12)
    target = ROOT/'experiments/fringe-coverage-budget/examples.png'
    fig.savefig(target, dpi=140); plt.close(fig); print(target)


if __name__ == '__main__': main()
