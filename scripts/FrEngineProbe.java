import com.fr.base.io.BaseBook;
import com.fr.io.reader.CptTemplateWorkBookReader;
import com.fr.main.TemplateWorkBook;
import com.fr.module.Module;
import com.fr.module.ModuleContext;
import com.fr.runtime.FineRuntime;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;

/**
 * Minimal FineReport engine compatibility probe.
 *
 * Usage:
 *   FrEngineProbe <input.cpt> [roundtrip-arg]        单文件模式（兼容旧调用；第二参数仅占位，
 *                                                    导出重读一律走临时文件，绝不覆写任何用户路径）
 *   FrEngineProbe --batch <a.cpt> <b.cpt> ...          批量模式：一次 JVM 启动校验多个模板，
 *                                                      每个模板做「加载 + 导出重读」并删除临时导出
 *
 * 批量模式的价值：FR 引擎冷启动约 10s，逐文件启动在校验整批交付模板时是主要开销。
 */
public final class FrEngineProbe {
    private FrEngineProbe() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length == 0 || args.length > 2 && !"--batch".equals(args[0])) {
            throw new IllegalArgumentException(
                "Usage: FrEngineProbe <input.cpt> [roundtrip-output.cpt] | FrEngineProbe --batch <a.cpt> [b.cpt ...]");
        }

        FineRuntime.start();
        Module root = ModuleContext.parseRoot("server-startup.xml");
        root.start();

        if ("--batch".equals(args[0])) {
            if (args.length < 2) {
                throw new IllegalArgumentException("批量模式至少需要一个 .cpt 输入");
            }
            int failures = 0;
            for (int i = 1; i < args.length; i++) {
                try {
                    roundTrip(args[i], null);
                } catch (Throwable t) {
                    failures++;
                    System.out.println("loaded=false file=" + args[i]);
                    System.out.println("error=" + String.valueOf(t.getMessage()).replaceAll("[\\r\\n]+", " | "));
                }
            }
            System.out.println("batchTotal=" + (args.length - 1));
            System.out.println("batchFailed=" + failures);
            System.out.flush();
            System.exit(failures == 0 ? 0 : 2);
            return;
        }

        if (args.length > 2) {
            throw new IllegalArgumentException("Usage: FrEngineProbe <input.cpt> [roundtrip-output.cpt]");
        }
        TemplateWorkBook workbook = readDirectly(args[0]);
        if (workbook == null) {
            throw new IllegalStateException("FineReport returned a null workbook");
        }

        System.out.println("loaded=true");
        System.out.println("reportCount=" + workbook.getReportCount());
        for (int index = 0; index < workbook.getReportCount(); index++) {
            System.out.println("report[" + index + "]=" + workbook.getReport(index).getClass().getName());
        }

        if (args.length == 2) {
            // 安全修复（2026-09-27）：导出目标一律用临时文件，绝不写 args[1]。
            // 原实现 new FileOutputStream(args[1]) 会把引擎重序列化结果直接覆写 args[1] 指向的文件；
            // 若调用方把 roundTrip 传成与输入相同路径（历史实际发生），源模板会被 FR 写回版本覆盖，
            // 且引擎 writer 会丢 WorkBook 级 TopJS 块（实测丢「售价跟随规格」整块）。
            File temp = File.createTempFile("cpt-mcp-rt-", ".cpt");
            try {
                try (OutputStream output = new FileOutputStream(temp)) {
                    ((BaseBook) workbook).export(output);
                }
                TemplateWorkBook roundTrip = readDirectly(temp.getAbsolutePath());
                if (roundTrip == null) {
                    throw new IllegalStateException("FineReport could not reload the round-trip output");
                }
                System.out.println("roundtrip=true");
                System.out.println("roundtripReportCount=" + roundTrip.getReportCount());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                temp.delete();
            }
        }
        System.out.flush();
        System.exit(0);
    }

    /** 加载 cpt → 导出临时文件 → 重读 → 删除临时文件，逐文件输出 loaded/roundtrip 行 */
    private static void roundTrip(String input, String unused) throws Exception {
        TemplateWorkBook workbook = readDirectly(input);
        if (workbook == null) {
            throw new IllegalStateException("FineReport returned a null workbook");
        }
        System.out.println("loaded=true file=" + input);
        System.out.println("reportCount=" + workbook.getReportCount() + " file=" + input);
        File temp = File.createTempFile("cpt-mcp-batch-rt-", ".cpt");
        try {
            try (OutputStream output = new FileOutputStream(temp)) {
                ((BaseBook) workbook).export(output);
            }
            TemplateWorkBook roundTrip = readDirectly(temp.getAbsolutePath());
            if (roundTrip == null) {
                throw new IllegalStateException("FineReport could not reload the round-trip output");
            }
            System.out.println("roundtrip=true file=" + input);
            System.out.println("roundtripReportCount=" + roundTrip.getReportCount() + " file=" + input);
        } finally {
            //noinspection ResultOfMethodCallIgnored
            temp.delete();
        }
    }

    private static TemplateWorkBook readDirectly(String path) throws Exception {
        Method method = CptTemplateWorkBookReader.class.getDeclaredMethod("readFromStream", InputStream.class);
        method.setAccessible(true);
        try (InputStream input = new FileInputStream(path)) {
            return (TemplateWorkBook) method.invoke(CptTemplateWorkBookReader.READER, input);
        }
    }
}
