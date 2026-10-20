// The confirmation dialog, drawn from describeTx's plain-words description.
import { Banner, Bold, Box, Divider, Heading, Row, Section, Text } from '@metamask/snaps-sdk/jsx';

const NOTE_COLOR = { info: 'alternative', warning: 'warning', danger: 'error', success: 'success' };

/** A short value on one row; a long one (an address, a hash, call data) under its label, line by line. */
function Field({ label, value }) {
  if (value.length <= 32 && !value.includes('\n')) {
    return (
      <Row label={label}>
        <Text>{value}</Text>
      </Row>
    );
  }
  return (
    <Box>
      <Text color="alternative" size="sm">{label}</Text>
      {value.split('\n').map((line) => <Text>{line}</Text>)}
    </Box>
  );
}

function Note({ note }) {
  if (note.title) {
    return (
      <Banner title={note.title} severity={note.severity}>
        <Text>{note.text}</Text>
      </Banner>
    );
  }
  return <Text color={NOTE_COLOR[note.severity] ?? 'default'}>{note.text}</Text>;
}

export function Confirmation({ view }) {
  return (
    <Box>
      <Heading>{view.title}</Heading>
      <Text>
        {view.requestedBy}: <Bold>{view.origin}</Bold>
      </Text>
      {view.banners.map((b) => <Note note={b} />)}
      {view.sections.map((s) => (
        <Section>
          <Heading size="sm">{s.title}</Heading>
          {s.rows.map(([label, value]) => <Field label={label} value={value} />)}
          {s.notes.map((n) => <Note note={n} />)}
        </Section>
      ))}
      <Section>
        {view.summary.map(([label, value]) => <Field label={label} value={value} />)}
      </Section>
      <Divider />
      <Text color="alternative">{view.footer}</Text>
    </Box>
  );
}
