import type { Metadata } from 'next';
import type { CSSProperties, ReactNode } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import {
  ACKNOWLEDGED_FINDINGS,
  AUDIT_LINKS,
  AUDIT_META,
  FINDING_CLASSES,
  FINDINGS,
  INTERNAL_REVIEWS_NOTE,
  OPEN_ITEMS,
  OPERATIONAL_NOTES,
  SCOPE,
  SEVERITIES,
  SEVERITY_COUNTS,
  TEST_RUN,
  TOTAL_COUNT,
  UNVALIDATED_FINDINGS,
  VALIDATED_FINDINGS,
  countFindings,
} from '@/data/security-audit';
import type { AuditFinding, Severity } from '@/data/security-audit';

/* Every finding, count and link on this page comes from @/data/security-audit. */

const countsLine = `${TOTAL_COUNT.total} findings, ${TOTAL_COUNT.closed} closed in code, ${TOTAL_COUNT.acknowledged} acknowledged and not fixed`;

export const metadata: Metadata = {
  title: 'Security — Covantic',
  description: `The V12 audit of Covantic at commit ${AUDIT_META.auditedCommit}: ${countsLine}, as verified at tag ${AUDIT_META.tag}.`,
  openGraph: {
    title: 'Security — Covantic',
    description: `V12 audit of commit ${AUDIT_META.auditedCommit}: ${countsLine}.`,
    url: 'https://covantic.org/security',
  },
};

const displayHeading = {
  fontFamily: 'var(--font-display)',
  fontWeight: 'var(--display-weight)' as never,
  letterSpacing: 'var(--display-tracking)',
} as const;

const bodyText: CSSProperties = {
  fontSize: 14,
  lineHeight: 1.65,
  color: 'var(--text-dim)',
  textWrap: 'pretty',
};

const linkStyle: CSSProperties = { color: 'var(--accent)' };

const sectionStyle: CSSProperties = { marginTop: 64, scrollMarginTop: 88 };

const listStyle: CSSProperties = {
  ...bodyText,
  listStyle: 'disc',
  paddingLeft: 20,
  display: 'grid',
  gap: 8,
};

const thStyle: CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  borderBottom: '1px solid var(--border-strong)',
};

const tdStyle: CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
  fontSize: 13,
  lineHeight: 1.55,
};

const SEVERITY_COLOR: Record<Severity, string> = {
  Critical: 'var(--c-critical)',
  High: 'var(--c-high)',
  Medium: 'var(--c-elevated)',
  Low: 'var(--text-dim)',
};

/** "1 Critical, 8 High, 3 Medium, 1 Low" — severities with no findings are left out. */
function severityBreakdown(rows: readonly AuditFinding[]): string {
  return SEVERITIES.map((severity) => ({
    severity,
    n: rows.filter((f) => f.severity === severity).length,
  }))
    .filter(({ n }) => n > 0)
    .map(({ severity, n }) => `${n} ${severity}`)
    .join(', ');
}

function Code({ children }: { children: ReactNode }) {
  return (
    <code
      className="cov-mono"
      style={{
        fontSize: '0.9em',
        color: 'var(--text)',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '0 4px',
        overflowWrap: 'anywhere',
      }}
    >
      {children}
    </code>
  );
}

/** Renders the data module's `backticked` spans as inline code. */
function RichText({ text }: { text: string }) {
  return (
    <>{text.split('`').map((part, i) => (i % 2 === 1 ? <Code key={i}>{part}</Code> : part))}</>
  );
}

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={linkStyle}>
      {children}
    </a>
  );
}

function SectionHeading({
  label,
  title,
  children,
}: {
  label: string;
  title: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 8 }}>
        {label}
      </div>
      <h2 style={{ ...displayHeading, fontSize: 26, lineHeight: 1.2, textWrap: 'balance' }}>
        {title}
      </h2>
      {children && <p style={{ ...bodyText, marginTop: 10, maxWidth: 780 }}>{children}</p>}
    </div>
  );
}

function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <span className="cov-badge" style={{ color: SEVERITY_COLOR[severity] }}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: AuditFinding['status'] }) {
  return status === 'closed' ? (
    <Badge variant="success">Closed</Badge>
  ) : (
    <Badge variant="warning">Acknowledged — not fixed</Badge>
  );
}

function FindingsTable({ rows, label }: { rows: readonly AuditFinding[]; label: string }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        aria-label={label}
        style={{ width: '100%', minWidth: 900, borderCollapse: 'collapse' }}
      >
        <thead>
          <tr>
            {['#', 'V12 id', 'Severity', 'Finding', 'Status', 'Closed by'].map((heading) => (
              <th key={heading} scope="col" className="cov-label" style={thStyle}>
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr
              key={f.number}
              id={`finding-${f.number}`}
              style={f.status === 'acknowledged' ? { background: 'var(--surface-2)' } : undefined}
            >
              <td className="cov-mono" style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                {f.number}
              </td>
              <td
                className="cov-mono"
                style={{ ...tdStyle, whiteSpace: 'nowrap', color: 'var(--text-dim)' }}
              >
                {f.v12Id}
              </td>
              <td style={tdStyle}>
                <SeverityBadge severity={f.severity} />
              </td>
              <td style={{ ...tdStyle, minWidth: 220, color: 'var(--text)' }}>
                <RichText text={f.title} />
              </td>
              <td style={{ ...tdStyle, whiteSpace: 'nowrap' }}>
                <StatusBadge status={f.status} />
              </td>
              <td style={{ ...tdStyle, minWidth: 320, color: 'var(--text-dim)' }}>
                {f.closedBy === null ? (
                  <>
                    Not fixed.{' '}
                    <a href={`#open-item-${f.number}`} style={linkStyle}>
                      See the open item
                    </a>
                    .
                  </>
                ) : (
                  <RichText text={f.closedBy} />
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ClassSummary({ title, rows }: { title: string; rows: readonly AuditFinding[] }) {
  const { total, closed, acknowledged } = countFindings(rows);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '56px minmax(0, 1fr)', gap: 12 }}>
      <span className="cov-mono" style={{ fontSize: 28, fontWeight: 700, lineHeight: 1.1 }}>
        {total}
      </span>
      <div>
        <p style={{ fontSize: 14, lineHeight: 1.45, color: 'var(--text)' }}>
          <RichText text={title} />
        </p>
        <p className="cov-mono" style={{ fontSize: 12, color: 'var(--text-dim)', marginTop: 4 }}>
          {severityBreakdown(rows)} · {closed} closed
          {acknowledged > 0 && `, ${acknowledged} acknowledged`}
        </p>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li
      className="cov-card"
      style={{
        padding: '20px 24px',
        display: 'grid',
        gridTemplateColumns: 'auto minmax(0, 1fr)',
        gap: 16,
      }}
    >
      <span className="cov-mono" style={{ fontSize: 13, color: 'var(--c-info)', paddingTop: 3 }}>
        {String(n).padStart(2, '0')}
      </span>
      <div style={{ display: 'grid', gap: 10, minWidth: 0 }}>
        <h3 style={{ ...displayHeading, fontSize: 17 }}>{title}</h3>
        {children}
      </div>
    </li>
  );
}

function CommandBlock({ lines }: { lines: readonly string[] }) {
  return (
    <pre
      className="cov-mono"
      style={{
        margin: 0,
        overflowX: 'auto',
        background: 'var(--surface-2)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: '12px 14px',
        fontSize: 12.5,
        lineHeight: 1.7,
        color: 'var(--text)',
      }}
    >
      {lines.join('\n')}
    </pre>
  );
}

export default function SecurityPage() {
  const unvalidated = countFindings(UNVALIDATED_FINDINGS);
  const findingByNumber = new Map(FINDINGS.map((f) => [f.number, f]));

  const facts: { label: string; value: ReactNode }[] = [
    {
      label: 'Auditor',
      value: <ExternalLink href={AUDIT_META.auditor.url}>{AUDIT_META.auditor.name}</ExternalLink>,
    },
    {
      label: 'Audited commit',
      value: (
        <ExternalLink href={AUDIT_LINKS.auditedCommit}>{AUDIT_META.auditedCommit}</ExternalLink>
      ),
    },
    {
      label: 'Verified commit',
      value: (
        <ExternalLink href={AUDIT_LINKS.verifiedCommit}>{AUDIT_META.verifiedCommit}</ExternalLink>
      ),
    },
    {
      label: 'Tag',
      value: <ExternalLink href={AUDIT_LINKS.tag}>{AUDIT_META.tag}</ExternalLink>,
    },
    { label: 'Verified on', value: AUDIT_META.verifiedOn },
  ];

  return (
    <div className="cov-page">
      {/* 1. Header */}
      <header>
        <div className="cov-label" style={{ color: 'var(--c-info)', marginBottom: 8 }}>
          Security
        </div>
        <h1 style={{ ...displayHeading, fontSize: 34, lineHeight: 1.15, textWrap: 'balance' }}>
          V12 audit of commit {AUDIT_META.auditedCommit}
        </h1>
        <p style={{ ...bodyText, fontSize: 15.5, marginTop: 14, maxWidth: 780 }}>
          <ExternalLink href={AUDIT_META.auditor.url}>{AUDIT_META.auditor.name}</ExternalLink>{' '}
          audited the Covantic repository at commit <Code>{AUDIT_META.auditedCommit}</Code> and
          reported {TOTAL_COUNT.total} findings. This page records how each one was handled, as
          verified on {AUDIT_META.verifiedOn} against commit{' '}
          <Code>{AUDIT_META.verifiedCommit}</Code>, tagged <Code>{AUDIT_META.tag}</Code>. It
          describes that one commit — not the code before it, and not any commit after it.
        </p>

        <Card
          style={{
            marginTop: 24,
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 20,
          }}
        >
          {facts.map((fact) => (
            <div key={fact.label} style={{ minWidth: 0 }}>
              <div className="cov-label">{fact.label}</div>
              <div className="cov-mono" style={{ marginTop: 8, fontSize: 14, fontWeight: 600 }}>
                {fact.value}
              </div>
            </div>
          ))}
        </Card>

        <p style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 12, maxWidth: 780 }}>
          This page is written by the Covantic team from two documents in our repository. It is not
          a V12 publication and implies no endorsement by V12.
        </p>
      </header>

      {/* 2. Summary */}
      <section id="summary" style={sectionStyle}>
        <SectionHeading
          label="Summary"
          title={`${TOTAL_COUNT.closed} of ${TOTAL_COUNT.total} findings closed in code, ${TOTAL_COUNT.acknowledged} acknowledged`}
        />

        {ACKNOWLEDGED_FINDINGS.length > 0 && (
          <div
            className="cov-card"
            style={{
              padding: '16px 20px',
              borderLeft: '3px solid var(--c-moderate)',
              marginBottom: 16,
            }}
          >
            <p style={{ fontSize: 14, lineHeight: 1.6 }}>
              {ACKNOWLEDGED_FINDINGS.length === 1
                ? 'One finding is'
                : `${ACKNOWLEDGED_FINDINGS.length} findings are`}{' '}
              acknowledged and <strong>not fixed</strong>:{' '}
              {ACKNOWLEDGED_FINDINGS.map((f, i) => (
                <span key={f.number}>
                  {i > 0 && '; '}finding {f.number} ({f.v12Id}), “<RichText text={f.title} />”
                </span>
              ))}
              .{' '}
              <a href="#open-item" style={linkStyle}>
                What bounds it, and what fixing it would take
              </a>
            </p>
          </div>
        )}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
            gap: 16,
          }}
        >
          <Card title="By severity">
            <div style={{ overflowX: 'auto' }}>
              <table
                aria-label="Findings by severity"
                style={{ width: '100%', borderCollapse: 'collapse' }}
              >
                <thead>
                  <tr>
                    {['Severity', 'Findings', 'Closed in code', 'Acknowledged'].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="cov-label"
                        style={{ ...thStyle, padding: '8px 10px 8px 0' }}
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="cov-mono">
                  {SEVERITY_COUNTS.map((row) => (
                    <tr key={row.severity}>
                      <td style={{ ...tdStyle, padding: '10px 10px 10px 0' }}>
                        <SeverityBadge severity={row.severity} />
                      </td>
                      <td style={{ ...tdStyle, padding: '10px 10px 10px 0' }}>{row.total}</td>
                      <td style={{ ...tdStyle, padding: '10px 10px 10px 0' }}>{row.closed}</td>
                      <td style={{ ...tdStyle, padding: '10px 10px 10px 0' }}>
                        {row.acknowledged}
                      </td>
                    </tr>
                  ))}
                  <tr style={{ fontWeight: 700, color: 'var(--text)' }}>
                    <td style={{ ...tdStyle, padding: '10px 10px 10px 0', borderBottom: 'none' }}>
                      Total
                    </td>
                    <td style={{ ...tdStyle, padding: '10px 10px 10px 0', borderBottom: 'none' }}>
                      {TOTAL_COUNT.total}
                    </td>
                    <td style={{ ...tdStyle, padding: '10px 10px 10px 0', borderBottom: 'none' }}>
                      {TOTAL_COUNT.closed}
                    </td>
                    <td style={{ ...tdStyle, padding: '10px 10px 10px 0', borderBottom: 'none' }}>
                      {TOTAL_COUNT.acknowledged}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Card>

          <Card title="By validation">
            <div style={{ display: 'grid', gap: 22 }}>
              <ClassSummary title={FINDING_CLASSES.validated.title} rows={VALIDATED_FINDINGS} />
              <ClassSummary title={FINDING_CLASSES.unvalidated.title} rows={UNVALIDATED_FINDINGS} />
            </div>
          </Card>
        </div>
      </section>

      {/* 3. Scope */}
      <section id="scope" style={sectionStyle}>
        <SectionHeading label="Scope" title="What the audit covered">
          <RichText text={SCOPE.summary} />{' '}
          <ExternalLink href={AUDIT_LINKS.program}>Browse the program at the tag</ExternalLink>.
        </SectionHeading>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 16,
          }}
        >
          {SCOPE.contracts.map((contract) => (
            <Card key={contract.name}>
              <h3 style={{ ...displayHeading, fontSize: 18, marginBottom: 8 }}>{contract.name}</h3>
              <p style={{ ...bodyText, fontSize: 13.5 }}>{contract.detail}</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 14 }}>
                {contract.instructions.map((instruction) => (
                  <Code key={instruction}>{instruction}</Code>
                ))}
              </div>
            </Card>
          ))}
        </div>

        <p style={{ ...bodyText, fontSize: 13.5, marginTop: 14, maxWidth: 780 }}>
          <RichText text={SCOPE.offChain} />
        </p>
      </section>

      {/* 4. Findings */}
      <section id="findings" style={sectionStyle}>
        <SectionHeading label="Findings" title="Every finding, and the change that closed it">
          The number is the order the report lists a finding in; the V12 id is the auditor&apos;s
          own. The report splits its findings into two classes, and so does this page.
        </SectionHeading>

        <h3 style={{ ...displayHeading, fontSize: 19 }}>
          {FINDING_CLASSES.validated.title} ({VALIDATED_FINDINGS.length})
        </h3>
        <p style={{ ...bodyText, fontSize: 13.5, marginTop: 6, marginBottom: 14, maxWidth: 780 }}>
          <RichText text={FINDING_CLASSES.validated.description} />
        </p>
        <Card style={{ padding: 0 }}>
          <FindingsTable rows={VALIDATED_FINDINGS} label={FINDING_CLASSES.validated.title} />
        </Card>

        <h3 style={{ ...displayHeading, fontSize: 19, marginTop: 40 }}>
          <RichText text={FINDING_CLASSES.unvalidated.title} /> ({UNVALIDATED_FINDINGS.length})
        </h3>
        <p style={{ ...bodyText, fontSize: 13.5, marginTop: 6, marginBottom: 14, maxWidth: 780 }}>
          <RichText text={FINDING_CLASSES.unvalidated.description} /> {unvalidated.closed} of the{' '}
          {unvalidated.total} are closed in code
          {unvalidated.acknowledged > 0 ? (
            <>
              ; {unvalidated.acknowledged === 1 ? 'the other one is' : 'the rest are'} acknowledged
              and not fixed — see{' '}
              <a href="#open-item" style={linkStyle}>
                the open item
              </a>
              .
            </>
          ) : (
            '.'
          )}
        </p>
        <details className="cov-card">
          <summary
            className="cov-mono"
            style={{ cursor: 'pointer', padding: '14px 18px', fontSize: 13 }}
          >
            Show all {UNVALIDATED_FINDINGS.length} observations
          </summary>
          <FindingsTable
            rows={UNVALIDATED_FINDINGS}
            label={FINDING_CLASSES.unvalidated.title.replaceAll('`', '')}
          />
        </details>
      </section>

      {/* 5. The open item */}
      {OPEN_ITEMS.length > 0 && (
        <section id="open-item" style={sectionStyle}>
          <SectionHeading
            label="Open item"
            title={
              OPEN_ITEMS.length === 1
                ? 'The one finding that is not fixed'
                : 'The findings that are not fixed'
            }
          />

          <div style={{ display: 'grid', gap: 16 }}>
            {OPEN_ITEMS.map((item) => {
              const finding = findingByNumber.get(item.findingNumber);
              if (!finding) return null;
              return (
                <article
                  key={item.findingNumber}
                  id={`open-item-${item.findingNumber}`}
                  className="cov-card"
                  style={{
                    padding: '24px 28px',
                    borderLeft: '3px solid var(--c-moderate)',
                    scrollMarginTop: 88,
                  }}
                >
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
                    <span className="cov-mono" style={{ fontSize: 12.5, color: 'var(--text-dim)' }}>
                      Finding {finding.number} · {finding.v12Id}
                    </span>
                    <SeverityBadge severity={finding.severity} />
                    {!finding.validated && (
                      <span className="cov-badge" style={{ color: 'var(--text-dim)' }}>
                        Marked Invalid
                      </span>
                    )}
                    <StatusBadge status={finding.status} />
                  </div>
                  <h3
                    style={{ ...displayHeading, fontSize: 22, marginTop: 14, textWrap: 'balance' }}
                  >
                    <RichText text={finding.title} />
                  </h3>

                  <div className="cov-label" style={{ marginTop: 22, marginBottom: 8 }}>
                    What is not proven
                  </div>
                  <p style={bodyText}>
                    <RichText text={item.gap} />
                  </p>
                  <p style={{ ...bodyText, marginTop: 10, color: 'var(--text)' }}>
                    <strong>This is accepted, not closed.</strong>
                  </p>

                  <div className="cov-label" style={{ marginTop: 22, marginBottom: 8 }}>
                    What bounds it today
                  </div>
                  <ul style={listStyle}>
                    {item.bounds.map((bound) => (
                      <li key={bound}>
                        <RichText text={bound} />
                      </li>
                    ))}
                  </ul>
                  <p style={{ ...bodyText, marginTop: 12 }}>
                    <RichText text={item.documentedIn} />
                  </p>

                  <div className="cov-label" style={{ marginTop: 22, marginBottom: 8 }}>
                    What closing it would take
                  </div>
                  <p style={bodyText}>
                    <RichText text={item.resolution} />
                  </p>
                </article>
              );
            })}
          </div>
        </section>
      )}

      {/* 6. Operational notes */}
      <section id="operations" style={sectionStyle}>
        <SectionHeading label="Operations" title="Operational notes">
          Not findings, but residual risk on already-deployed state.
        </SectionHeading>
        <Card>
          <ul style={listStyle}>
            {OPERATIONAL_NOTES.map((note) => (
              <li key={note}>
                <RichText text={note} />
              </li>
            ))}
          </ul>
        </Card>
      </section>

      {/* 7. How to verify */}
      <section id="verify" style={sectionStyle}>
        <SectionHeading label="Verify" title="How to verify this yourself">
          Every statement above is pinned to one tag. Check it out, run the suite, and compare the
          result and the source with the two documents.
        </SectionHeading>

        <ol style={{ display: 'grid', gap: 12, listStyle: 'none', padding: 0 }}>
          <Step n={1} title="Check out the tagged commit">
            <CommandBlock
              lines={[
                `git clone ${AUDIT_META.repo.url}.git`,
                'cd covantic',
                `git checkout ${AUDIT_META.tag}`,
              ]}
            />
            <p style={{ ...bodyText, fontSize: 13.5 }}>
              <ExternalLink href={AUDIT_LINKS.tag}>{AUDIT_META.tag}</ExternalLink> points at{' '}
              <Code>{AUDIT_META.verifiedCommitFull}</Code>.
            </p>
          </Step>

          <Step n={2} title="Read the regression suite">
            <p style={{ ...bodyText, fontSize: 13.5 }}>
              <ExternalLink href={AUDIT_LINKS.regressionSuite}>
                {AUDIT_META.regressionSuite}
              </ExternalLink>{' '}
              names its cases after the finding numbers. It is the executable counterpart to the
              verification document.
            </p>
          </Step>

          <Step n={3} title="Run it">
            <p style={{ ...bodyText, fontSize: 13.5 }}>
              With {TEST_RUN.toolchain.join(' and ')}, from the repository root:
            </p>
            <CommandBlock
              lines={[
                'pnpm install',
                ...TEST_RUN.prepare,
                `cd ${TEST_RUN.directory}`,
                ...TEST_RUN.commands,
              ]}
            />
            <p style={{ ...bodyText, fontSize: 13.5 }}>
              Keep <Code>--provider.cluster localnet</Code>: <Code>Anchor.toml</Code> points the
              provider at devnet. The suite runs in process on <Code>solana-bankrun</Code>, so it
              needs no validator and deploys nothing.
            </p>
          </Step>

          <Step n={4} title="Compare with our run">
            <p style={{ ...bodyText, fontSize: 13.5 }}>
              On {TEST_RUN.date}, at commit <Code>{TEST_RUN.commit}</Code>:
            </p>
            <div style={{ overflowX: 'auto' }}>
              <table
                aria-label="Recorded test run"
                className="cov-mono"
                style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}
              >
                <thead>
                  <tr>
                    {['Suite', 'Passed', 'Failed'].map((heading) => (
                      <th
                        key={heading}
                        scope="col"
                        className="cov-label"
                        style={{ ...thStyle, padding: '8px 12px 8px 0' }}
                      >
                        {heading}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {TEST_RUN.results.map((result) => (
                    <tr key={result.suite}>
                      <td style={{ ...tdStyle, padding: '8px 12px 8px 0' }}>{result.suite}</td>
                      <td style={{ ...tdStyle, padding: '8px 12px 8px 0', color: 'var(--c-low)' }}>
                        {result.passed}
                      </td>
                      <td style={{ ...tdStyle, padding: '8px 12px 8px 0' }}>{result.failed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Step>

          <Step n={5} title="Read the documents">
            <ul style={{ ...listStyle, fontSize: 13.5 }}>
              {AUDIT_META.documents.map((doc) => (
                <li key={doc.path}>
                  <ExternalLink href={AUDIT_LINKS.document(doc.path)}>{doc.path}</ExternalLink>
                  <br />
                  {doc.label}
                </li>
              ))}
            </ul>
          </Step>
        </ol>

        <p style={{ fontSize: 12.5, color: 'var(--text-faint)', marginTop: 16, maxWidth: 780 }}>
          <RichText text={INTERNAL_REVIEWS_NOTE} />
        </p>
      </section>
    </div>
  );
}
