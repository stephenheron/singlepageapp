// Bun supports importing files as text via `with { type: "text" }`, embedding
// the contents as a string (and into the compiled binary under --compile).
declare module "*.md" {
  const content: string;
  export default content;
}
