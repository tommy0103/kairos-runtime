// 现在调用新注册的sha256_hex工具计算指定字符串的哈希值
export async function calculateHash() {
    const result = await sha256_hex.execute('call1', { text: 'memoh_lite_agent_framework_2026' });
    return result;
}
calculateHash().then(res => console.log(res.content[0].text));
export default undefined;
