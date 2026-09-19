import numpy as np
import pytest
from backend.vision.heightmap_analysis import compute_psd_1d


@pytest.mark.parametrize('n', [5, 6, 31, 32, 101, 102])
def test_one_sided_psd_preserves_two_sided_spectral_power(n):
    spacing = .25
    z = np.random.default_rng(123).normal(size=n)
    window = np.hanning(n)
    transformed = np.fft.fft((z-z.mean())*window)
    full_psd = abs(transformed)**2 * spacing / np.sum(window**2)
    result = compute_psd_1d(z, spacing)
    # DC is deliberately omitted by the API. All other spectral power must remain.
    assert sum(result['psd']) == pytest.approx(sum(full_psd[1:]), rel=1e-12)
    # Independently combine the positive and negative frequency partners.
    k = n//2
    expected_last = full_psd[k] if k == n-k else full_psd[k]+full_psd[n-k]
    assert result['psd'][-1] == pytest.approx(expected_last)
