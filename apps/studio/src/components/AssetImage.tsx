import { useEffect, useState } from 'react';
import { useStudioClient } from '../api';
import type { Asset } from '../../../../packages/core/src/media-contracts';

export function AssetImage({ projectId, asset }: { projectId: string; asset: Asset }) {
  const { mediaImage } = useStudioClient();
  const [url, setUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true, blob = ''; setUrl(''); setError('');
    void mediaImage(projectId, asset.id).then(value => { blob = value; if (active) setUrl(value); else URL.revokeObjectURL(value); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; if (blob) URL.revokeObjectURL(blob); };
  }, [projectId, asset.id, retry]);
  return error ? <div role="alert">{error}<button type="button" onClick={() => setRetry(retry + 1)}>Retry image</button></div> : url ? <img src={url} alt={asset.label} width={asset.width} height={asset.height} /> : <span>Loading image…</span>;
}
