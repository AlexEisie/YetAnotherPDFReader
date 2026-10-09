/** Sticky-note icons in a 20×20 box (y down), matching the appearances written by the PDF core. */

const STROKE = "rgb(40 40 40 / 0.85)";

export function NoteIcon({ name, fill }: { name: string | null; fill: string }) {
  const common = { fill, stroke: STROKE, strokeWidth: 1, strokeLinejoin: "round" as const };
  switch (name) {
    case "Note":
      return (
        <g>
          <path d="M3.5 1.5h9l4 4v13h-13z" {...common} />
          <path d="M12.5 1.5v4h4" fill="none" stroke={STROKE} strokeWidth={1} />
          <path d="M6 9h8M6 12h8M6 15h5" stroke={STROKE} strokeWidth={1.1} strokeLinecap="round" />
        </g>
      );
    case "Help":
      return (
        <g>
          <circle cx={10} cy={10} r={8.5} {...common} />
          <path d="M7.4 7.6a2.7 2.7 0 1 1 3.8 2.5c-.8.4-1.2.9-1.2 1.8v.6" fill="none" stroke={STROKE} strokeWidth={1.7} strokeLinecap="round" />
          <circle cx={10} cy={15} r={1.05} fill={STROKE} />
        </g>
      );
    case "Insert":
      return <path d="M2 17.5L10 3l8 14.5h-4.2L10 10.4l-3.8 7.1z" {...common} />;
    case "Key":
      return (
        <g>
          <circle cx={6.5} cy={10} r={4.5} {...common} />
          <path d="M11 9h7v2.5h-1.5V14h-2v-2.5h-1.5V14h-2v-2.5H11z" {...common} />
          <circle cx={6.5} cy={10} r={1.4} fill={STROKE} />
        </g>
      );
    case "NewParagraph":
    case "Paragraph":
      return (
        <g>
          <rect x={1.5} y={1.5} width={17} height={17} rx={3} {...common} />
          <path d="M9 15V5.5h5M12 15V5.5M9 10.5H8a2.5 2.5 0 0 1 0-5h1" fill="none" stroke={STROKE} strokeWidth={1.4} strokeLinecap="round" />
          {name === "NewParagraph" && <path d="M3.5 4l2 2-2 2" fill="none" stroke={STROKE} strokeWidth={1.2} />}
        </g>
      );
    case "Check":
      return <path d="M2.5 10.5l4.8 5L17.5 4l1 1.5L7.5 18 1.5 12z" {...common} />;
    case "Cross":
      return (
        <path
          d="M4 2l6 6 6-6 2 2-6 6 6 6-2 2-6-6-6 6-2-2 6-6-6-6z"
          {...common}
        />
      );
    case "Star":
      return <path d="M10 1.5l2.6 5.5 6 .8-4.4 4.1 1.1 6L10 15l-5.3 2.9 1.1-6L1.4 7.8l6-.8z" {...common} />;
    case "Circle":
      return (
        <g>
          <circle cx={10} cy={10} r={8.5} {...common} />
          <circle cx={10} cy={10} r={4} fill="none" stroke={STROKE} strokeWidth={1.2} />
        </g>
      );
    default:
      // "Comment" speech bubble
      return (
        <g>
          <path d="M3.5 2h13A2.5 2.5 0 0 1 19 4.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V15h-2A2.5 2.5 0 0 1 1 12.5v-8A2.5 2.5 0 0 1 3.5 2z" {...common} />
          <path d="M5 6.5h10M5 9.5h7" stroke={STROKE} strokeWidth={1.1} strokeLinecap="round" />
        </g>
      );
  }
}
