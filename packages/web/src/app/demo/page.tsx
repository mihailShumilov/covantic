'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { ClaimVerificationPipeline } from '@/components/claims/ClaimVerificationPipeline';
import { apiPost } from '@/lib/api-client';

const DEMO_AGENT = '3kTzqDN8uEZwFEhQKvPXDvMkZxvPcFpHgEL9mJQfYWxC';

export default function DemoPage() {
  const [pipelineActive, setPipelineActive] = useState(false);
  const [simulationType, setSimulationType] = useState<string | null>(null);
  const [simulationLog, setSimulationLog] = useState<string[]>([]);

  const simulate = async (type: string) => {
    setSimulationType(type);
    setPipelineActive(false);
    setSimulationLog([]);

    const labels: Record<string, string> = {
      exploit: 'Exploit Detection',
      oracle_deviation: 'Oracle Manipulation',
      agent_error: 'Agent Error',
      governance_attack: 'Governance Attack',
    };

    setSimulationLog((prev) => [...prev, `Simulating ${labels[type]}...`]);

    try {
      await apiPost('/api/demo/simulate-exploit', { agentAddress: DEMO_AGENT, type });
      setSimulationLog((prev) => [...prev, 'Anomaly detected by monitoring system']);
      setSimulationLog((prev) => [...prev, 'Auto-submitting insurance claim...']);

      // Start pipeline animation
      setTimeout(() => {
        setPipelineActive(true);
        setSimulationLog((prev) => [...prev, 'Verification pipeline started']);
      }, 1000);
    } catch (err) {
      setSimulationLog((prev) => [...prev, `Error: ${err}`]);
    }
  };

  return (
    <div style={{ padding: 'var(--space-xl)', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 'var(--space-xl)' }}>
        <Badge variant="warning">DEMO MODE</Badge>
        <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginTop: 'var(--space-sm)' }}>
          AgentGuard Demo
        </h1>
        <p style={{ color: 'var(--color-text-secondary)', marginTop: 'var(--space-xs)' }}>
          Simulate insurance scenarios and watch the full claim-to-payout pipeline in action.
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-lg)' }}>
        {/* Simulation Controls */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
          <Card title="Simulate Incident">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
              <Button
                onClick={() => simulate('exploit')}
                variant={simulationType === 'exploit' ? 'primary' : 'secondary'}
              >
                Simulate Exploit
              </Button>
              <Button
                onClick={() => simulate('oracle_deviation')}
                variant={simulationType === 'oracle_deviation' ? 'primary' : 'secondary'}
              >
                Simulate Oracle Manipulation
              </Button>
              <Button
                onClick={() => simulate('agent_error')}
                variant={simulationType === 'agent_error' ? 'primary' : 'secondary'}
              >
                Simulate Agent Error
              </Button>
              <Button
                onClick={() => simulate('governance_attack')}
                variant={simulationType === 'governance_attack' ? 'primary' : 'secondary'}
              >
                Simulate Governance Attack
              </Button>
            </div>
          </Card>

          {/* Demo Agent Info */}
          <Card title="Demo Agent: RiskyBot">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-md)' }}>
              <div>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>Risk Tier</p>
                <Badge variant="danger">HIGH</Badge>
              </div>
              <div>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>Coverage</p>
                <p style={{ fontWeight: 600 }}>$100.00 USDC</p>
              </div>
              <div>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>Premium</p>
                <p style={{ fontWeight: 600 }}>$0.55 USDC</p>
              </div>
              <div>
                <p style={{ color: 'var(--color-text-muted)', fontSize: '0.75rem' }}>Policy Duration</p>
                <p style={{ fontWeight: 600 }}>24 hours</p>
              </div>
            </div>
            <div style={{ marginTop: 'var(--space-md)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', color: 'var(--color-text-muted)', wordBreak: 'break-all' }}>
              {DEMO_AGENT}
            </div>
          </Card>

          {/* Simulation Log */}
          {simulationLog.length > 0 && (
            <Card title="Event Log">
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8125rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {simulationLog.map((log, i) => (
                  <div key={i} className="animate-fadeIn" style={{ color: 'var(--color-text-secondary)' }}>
                    <span style={{ color: 'var(--color-text-muted)' }}>[{new Date().toLocaleTimeString()}]</span> {log}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>

        {/* Verification Pipeline */}
        <Card title="Claim Verification Pipeline">
          {pipelineActive ? (
            <ClaimVerificationPipeline
              autoPlay={true}
              onComplete={() => {
                setSimulationLog((prev) => [...prev, 'Payout completed! USDC transferred to agent owner.']);
              }}
            />
          ) : (
            <div style={{ textAlign: 'center', padding: 'var(--space-2xl)', color: 'var(--color-text-muted)' }}>
              <p>Select a simulation to start the verification pipeline</p>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
