import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SectionShell } from './SectionShell';
import { settingsApi } from './api';
import { Button } from '@/components/Button';
import { Input } from '@/components/Input';
import { useToast } from '@/components/Toast';

export function WorkLocationsSection() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings', 'work-locations'], queryFn: settingsApi.workLocations.list });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');
  const [lat, setLat] = useState('');
  const [lon, setLon] = useState('');
  const [radius, setRadius] = useState('150');

  const create = useMutation({
    mutationFn: () =>
      settingsApi.workLocations.create({
        name,
        address,
        latitude: Number(lat),
        longitude: Number(lon),
        radius_m: Number(radius),
      }),
    onSuccess: () => {
      toast.push('success', 'Work location created.');
      qc.invalidateQueries({ queryKey: ['settings', 'work-locations'] });
      setAdding(false);
      setName('');
      setAddress('');
      setLat('');
      setLon('');
      setRadius('150');
    },
    onError: (e: Error) => toast.push('error', e.message),
  });
  const toggle = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) => settingsApi.workLocations.patch(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'work-locations'] }),
    onError: (e: Error) => toast.push('error', e.message),
  });

  return (
    <SectionShell
      title="Work locations"
      description="Attendance geofence checks Haversine distance against active locations (§8.2)."
      addLabel={adding ? undefined : 'Add location'}
      onAdd={adding ? undefined : () => setAdding(true)}
    >
      {adding ? (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            create.mutate();
          }}
          className="bg-white border border-neutral-200 rounded p-4 grid grid-cols-1 md:grid-cols-2 gap-3"
        >
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Address" value={address} onChange={(e) => setAddress(e.target.value)} />
          <Input label="Latitude" value={lat} onChange={(e) => setLat(e.target.value)} required />
          <Input label="Longitude" value={lon} onChange={(e) => setLon(e.target.value)} required />
          <Input label="Radius (metres)" value={radius} onChange={(e) => setRadius(e.target.value)} />
          <div className="flex items-end gap-2">
            <Button variant="primary" type="submit" disabled={create.isPending}>Save</Button>
            <Button variant="ghost" type="button" onClick={() => setAdding(false)}>Cancel</Button>
          </div>
        </form>
      ) : null}
      <div className="bg-white border border-neutral-200 rounded overflow-hidden">
        <table className="w-full border-collapse tabular-nums">
          <thead>
            <tr>
              {['Name', 'Coordinates', 'Radius', 'Active', 'Actions'].map((c) => (
                <th key={c} className="text-left text-11 uppercase tracking-[0.06em] text-neutral-500 px-3 py-2 border-b border-neutral-300 font-medium">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(q.data?.items ?? []).map((wl) => (
              <tr key={wl.id} className={'border-b border-neutral-200 border-l-2 ' + (wl.is_active ? 'border-transparent' : 'border-neutral-400')}>
                <td className="px-3 py-2">
                  <div className="text-13 text-neutral-900">{wl.name}</div>
                  <div className="text-11 text-neutral-500">{wl.address}</div>
                </td>
                <td className="px-3 py-2 text-13 text-neutral-700">
                  {wl.latitude.toFixed(4)}, {wl.longitude.toFixed(4)}
                </td>
                <td className="px-3 py-2 text-13 text-neutral-900">{wl.radius_m} m</td>
                <td className="px-3 py-2 text-13 text-neutral-700">{wl.is_active ? 'Active' : 'Inactive'}</td>
                <td className="px-3 py-2">
                  <Button
                    variant="ghost"
                    onClick={() => toggle.mutate({ id: wl.id, is_active: !wl.is_active })}
                  >
                    {wl.is_active ? 'Deactivate' : 'Activate'}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionShell>
  );
}
