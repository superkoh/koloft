# N05 three diagrams, two formulas, three code blocks

nfr-n05-opening-line

```mermaid
flowchart TD
  A["n05-flow-a"] --> B["n05-flow-b"]
```

```bash
echo n05-first-code-block
```

Inline formula: $E = mc^2$ stays inline.

```mermaid
sequenceDiagram
  participant N05A as n05-seq-a
  participant N05B as n05-seq-b
  N05A->>N05B: n05-seq-hello
```

```ts
export const n05 = { second: true }
```

$$\frac{n05}{block}$$

```mermaid
pie title n05-pie-title
  "n05-slice-a" : 40
  "n05-slice-b" : 60
```

```python
print("n05-third-code-block")
```

nfr-n05-closing-line
