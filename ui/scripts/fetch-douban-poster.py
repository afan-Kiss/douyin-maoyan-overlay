import re
import sys
import urllib.request

subject_id = sys.argv[1] if len(sys.argv) > 1 else "35811064"
out = sys.argv[2] if len(sys.argv) > 2 else "poster.jpg"

url = f"https://movie.douban.com/subject/{subject_id}/"
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
html = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "ignore")

match = re.search(
    r"https://img\d+\.doubanio\.com/view/photo/s_ratio_poster/public/p\d+\.webp",
    html,
) or re.search(
    r"https://img\d+\.doubanio\.com/view/photo/s_ratio_poster/public/p\d+\.jpg",
    html,
)
if not match:
    raise SystemExit("poster url not found")

poster_url = match.group(0).replace("/s_ratio_poster/", "/l/")
print("poster:", poster_url)

req2 = urllib.request.Request(poster_url, headers={"User-Agent": "Mozilla/5.0"})
data = urllib.request.urlopen(req2, timeout=30).read()
with open(out, "wb") as f:
    f.write(data)
print("saved:", out, len(data), "bytes")
