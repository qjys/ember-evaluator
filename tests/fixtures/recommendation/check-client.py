"""Exercise the SID and tokenizer checks with small, synthetic catalogs."""
import importlib.util
import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location("gr_measure", sys.argv[1])
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)
p1, p2 = {"0": [2]}, {"0,2": [3]}
client.load_catalog(p1, p2)
ids = [151669, 159863, 168056]


def choice(tokens, score=0):
    return {"choices": [{"output_ids": tokens, "score": score}]}


def decode(response, depth=3):
    row = dict(e2eMs=12, status="error", outputTokens=0)
    client.record_choices(row, response, depth, p1, p2)
    return row


for depth in range(1, 4):
    row = decode(choice(ids[:depth]), depth)
    assert row["sidValid"] and row["scoresFinite"] and row["outputTokens"] == depth
for tokens in (ids[:-1], [151670, *ids[1:]], [ids[0], 159861, ids[2]], [*ids[:2], 168053]):
    row = decode(choice(tokens))
    assert row["status"] == "ok" and not row["sidValid"] and row["scoresFinite"]
for score in ("nan", None):
    row = decode(choice(ids, score))
    assert row["status"] == "ok" and row["sidValid"] and not row["scoresFinite"]
for response in ({"error": "failed"}, {"choices": []}):
    assert decode(response)["status"] == "error"
row = decode({"choices": [dict(output_ids=ids, score=0, finish_reason="stop"), dict(output_ids=ids, score="nan")]})
assert row["outputIds"] == ids and row["choiceCount"] == 2 and row["outputTokens"] == 6
assert row["perTokenMs"] == 2 and row["score"] == 0 and row["finishReason"] == "stop"
assert row["sidDetail"] == "(0,2,3); (0,2,3)" and not row["scoresFinite"]

tokenizer = Mock()
tokenizer.encode.return_value = [1, 2, 3]
vocab = {"<s_a_0>": ids[0], "<s_b_2>": ids[1], "<s_c_3>": ids[2]}
tokenizer.get_vocab.return_value = vocab
with patch.dict(sys.modules, transformers=SimpleNamespace(AutoTokenizer=Mock(from_pretrained=Mock(return_value=tokenizer)))):
    assert client.tokenize_inputs(".", ["unchanged"], 4, 1, p1, p2) == [3]
    for invalid in ("length", "vocab"):
        if invalid == "vocab":
            vocab["<s_a_0>"] = 10
        try:
            client.tokenize_inputs(".", ["unchanged"], 4, 0, p1, p2)
        except ValueError as error:
            assert ("lengths" if invalid == "length" else "offsets") in str(error)
        else:
            raise AssertionError(f"invalid {invalid} accepted")
