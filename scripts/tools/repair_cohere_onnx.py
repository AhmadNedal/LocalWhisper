"""Repair the q4f16 Cohere Transcribe Arabic ONNX export:
- drop stale value_info type hints,
- point external data at the real .onnx_data file names,
- make every elementwise op's inputs one type (constants / Casts follow the other input)."""
import sys, numpy as np, onnx
from onnx import numpy_helper, shape_inference, helper, TensorProto

SAME = {"Add", "Mul", "Sub", "Div", "Pow", "Max", "Min", "Equal", "Where", "MatMul", "Concat"}

def repair(src, dst, data_name):
    m = onnx.load(src, load_external_data=False)
    del m.graph.value_info[:]
    for t in m.graph.initializer:
        for e in t.external_data:
            if e.key == "location":
                e.value = data_name
    for _round in range(10):
        inf = shape_inference.infer_shapes(m)
        types = {v.name: v.type.tensor_type.elem_type for v in list(inf.graph.value_info) + list(inf.graph.input) + list(inf.graph.output)}
        for t in m.graph.initializer:
            types[t.name] = t.data_type
        producer = {o: n for n in m.graph.node for o in n.output}
        fixed = 0
        for n in list(m.graph.node):
            # MatMulNBits: input A must have the type of its scales (input 2).
            if n.op_type == "MatMulNBits" and len(n.input) > 2:
                a, sc = n.input[0], n.input[2]
                if types.get(a) and types.get(sc) and types[a] != types[sc]:
                    cast_out = a + "__to" + str(types[sc])
                    if cast_out not in producer:
                        m.graph.node.append(helper.make_node("Cast", [a], [cast_out], to=types[sc], name=cast_out + "_node"))
                        producer[cast_out] = m.graph.node[-1]
                    n.input[0] = cast_out
                    fixed += 1
                continue
            if n.op_type not in SAME:
                continue
            ins = [i for i in n.input if i]
            if n.op_type == "Where":
                ins = ins[1:]
            ts = {types.get(i) for i in ins} - {None, 0}
            if len(ts) < 2:
                continue
            # the "real" type: the one of an input that is not a Constant / Cast
            anchor = None
            for i in ins:
                p = producer.get(i)
                if p is None or p.op_type not in ("Constant", "Cast"):
                    anchor = types.get(i); break
            if anchor is None:
                anchor = types.get(ins[0])
            for i in ins:
                if types.get(i) == anchor:
                    continue
                p = producer.get(i)
                if p is not None and p.op_type == "Constant":
                    for a in p.attribute:
                        if a.name == "value":
                            arr = numpy_helper.to_array(a.t)
                            dtype = np.float16 if anchor == TensorProto.FLOAT16 else np.float32
                            a.t.CopyFrom(numpy_helper.from_array(arr.astype(dtype), a.t.name))
                    fixed += 1
                elif p is not None and p.op_type == "Cast":
                    for a in p.attribute:
                        if a.name == "to":
                            a.i = anchor
                    fixed += 1
                else:  # insert a Cast in front of this input
                    cast_out = i + "__cast"
                    m.graph.node.append(helper.make_node("Cast", [i], [cast_out], to=anchor, name=i + "__cast_node"))
                    n.input[list(n.input).index(i)] = cast_out
                    fixed += 1
        print(f"  round {_round}: fixed {fixed}")
        if not fixed:
            break
    # Distinct names for independent sequence lengths: the self-attention cache
    # (past), the encoder output (cross) and the grown cache (present) are all
    # called "seq" in the export, which makes ONNX Runtime assume they're equal.
    rename = {"self_k": "past_seq", "self_v": "past_seq", "cross_k": "enc_seq", "cross_v": "enc_seq",
              "self_k_out": "total_seq", "self_v_out": "total_seq"}
    for v in list(m.graph.input) + list(m.graph.output):
        if v.name in rename:
            for d in v.type.tensor_type.shape.dim:
                if d.dim_param == "seq":
                    d.dim_param = rename[v.name]
    # re-sort topologically (inserted Casts were appended)
    order, seen, byout = [], set(), {o: n for n in m.graph.node for o in n.output}
    avail = {i.name for i in m.graph.input} | {t.name for t in m.graph.initializer} | {""}
    def visit(n):
        if id(n) in seen: return
        seen.add(id(n))
        for i in n.input:
            if i not in avail and i in byout: visit(byout[i])
        order.append(n)
    for n in list(m.graph.node): visit(n)
    del m.graph.node[:]; m.graph.node.extend(order)
    onnx.save(m, dst)

if __name__ == "__main__":
    repair(sys.argv[1], sys.argv[2], sys.argv[3])
